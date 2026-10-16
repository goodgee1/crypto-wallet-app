const express = require('express');
const Order = require('../models/Order');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { auth } = require('../middleware/auth');
const { notify } = require('../middleware/notify');
const router = express.Router();

// Reference prices in USDT (in a real app these come from an exchange feed)
const BASE_PRICES = { 'BTC/USDT': 68000, 'ETH/USDT': 3500 };

// Cache for generated order book depth (regenerated each request)
function buildOrderBook(pair) {
  const mid = BASE_PRICES[pair];
  if (!mid) return null;

  const bids = [];
  const asks = [];

  for (let i = 0; i < 12; i++) {
    // bids below mid
    const bidPrice = mid * (1 - 0.0006 * (i + 1) - Math.random() * 0.0004);
    const bidAmount = +(0.05 + Math.random() * 2).toFixed(4);
    bids.push({ price: +bidPrice.toFixed(2), amount: bidAmount, total: +(bidPrice * bidAmount).toFixed(2) });

    // asks above mid
    const askPrice = mid * (1 + 0.0006 * (i + 1) + Math.random() * 0.0004);
    const askAmount = +(0.05 + Math.random() * 2).toFixed(4);
    asks.push({ price: +askPrice.toFixed(2), amount: askAmount, total: +(askPrice * askAmount).toFixed(2) });
  }

  // Sort: bids high→low, asks low→high
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);

  return { pair, mid, bids, asks, updatedAt: new Date() };
}

// Public: get order book for a pair
router.get('/book/:pair', auth, (req, res) => {
  const pair = req.params.pair.replace('-', '/');
  const book = buildOrderBook(pair);
  if (!book) return res.status(400).json({ error: 'Unsupported pair' });
  res.json(book);
});

// Public: recent trades (simulated)
router.get('/trades/:pair', auth, (req, res) => {
  const pair = req.params.pair.replace('-', '/');
  const mid = BASE_PRICES[pair];
  if (!mid) return res.status(400).json({ error: 'Unsupported pair' });

  const trades = [];
  for (let i = 0; i < 20; i++) {
    const side = Math.random() > 0.5 ? 'buy' : 'sell';
    const price = mid * (1 + (Math.random() - 0.5) * 0.004);
    const amount = +(0.001 + Math.random() * 0.5).toFixed(4);
    const secondsAgo = Math.floor(Math.random() * 300);
    trades.push({
      side,
      price: +price.toFixed(2),
      amount,
      time: new Date(Date.now() - secondsAgo * 1000)
    });
  }
  trades.sort((a, b) => b.time - a.time);
  res.json(trades);
});

// My orders
router.get('/my', auth, async (req, res) => {
  const orders = await Order.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(50);
  res.json(orders);
});

// Place order
router.post('/', auth, async (req, res) => {
  try {
    const { side, pair, type = 'limit', price, amount } = req.body;
    if (!['buy', 'sell'].includes(side)) return res.status(400).json({ error: 'Invalid side' });
    if (!BASE_PRICES[pair]) return res.status(400).json({ error: 'Unsupported pair' });

    const amt = Number(amount);
    const p = Number(price) || BASE_PRICES[pair];
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (p <= 0) return res.status(400).json({ error: 'Invalid price' });

    const [base, quote] = pair.split('/');
    const user = await User.findById(req.user._id);

    // Balance checks
    if (side === 'buy') {
      const cost = p * amt;
      if (user.balances[quote] < cost)
        return res.status(400).json({ error: `Insufficient ${quote} balance` });
      // Lock quote
      user.balances[quote] -= cost;
      user.locked[quote] = (user.locked[quote] || 0) + cost;
    } else {
      if (user.balances[base] < amt)
        return res.status(400).json({ error: `Insufficient ${base} balance` });
      // Lock base
      user.balances[base] -= amt;
      user.locked[base] = (user.locked[base] || 0) + amt;
    }
    await user.save();

    const order = await Order.create({ user: user._id, side, pair, type, price: p, amount: amt });

    // Simulate: partial or full fill after a short delay if price is close to market
    const mid = BASE_PRICES[pair];
    const diff = Math.abs(p - mid) / mid;

    // If within 0.3% of market, fill it after 3 seconds
    if (diff < 0.003) {
      setTimeout(() => tryFillOrder(order._id).catch(() => {}), 3000);
    }

    await notify(user._id, 'system',
      `Order placed`,
      `${side.toUpperCase()} ${amt} ${base} @ ${p} ${quote} on ${pair}`);

    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cancel order
router.post('/:id/cancel', auth, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!['open', 'partial'].includes(order.status))
      return res.status(400).json({ error: 'Cannot cancel this order' });

    const [base, quote] = order.pair.split('/');
    const user = await User.findById(req.user._id);
    const remaining = order.amount - order.filled;

    if (order.side === 'buy') {
      const refund = order.price * remaining;
      user.locked[quote] = Math.max(0, (user.locked[quote] || 0) - refund);
      user.balances[quote] += refund;
    } else {
      user.locked[base] = Math.max(0, (user.locked[base] || 0) - remaining);
      user.balances[base] += remaining;
    }
    await user.save();

    order.status = 'cancelled';
    order.updatedAt = new Date();
    await order.save();

    await notify(user._id, 'system', 'Order cancelled', `${order.side.toUpperCase()} ${order.amount} ${base} @ ${order.price} ${quote}`);
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Internal: fill an order
async function tryFillOrder(orderId) {
  const order = await Order.findById(orderId);
  if (!order || !['open', 'partial'].includes(order.status)) return;

  const [base, quote] = order.pair.split('/');
  const user = await User.findById(order.user);
  const remaining = order.amount - order.filled;
  const fillAmount = remaining; // full fill in this simulation

  if (order.side === 'buy') {
    const cost = order.price * fillAmount;
    // release locked quote, credit base
    user.locked[quote] = Math.max(0, (user.locked[quote] || 0) - cost);
    user.balances[base] = (user.balances[base] || 0) + fillAmount;
  } else {
    // release locked base, credit quote
    user.locked[base] = Math.max(0, (user.locked[base] || 0) - fillAmount);
    user.balances[quote] = (user.balances[quote] || 0) + (order.price * fillAmount);
  }
  await user.save();

  order.filled += fillAmount;
  order.status = 'filled';
  order.updatedAt = new Date();
  await order.save();

  await Transaction.create({
    user: user._id,
    type: 'earn',
    currency: order.side === 'buy' ? base : quote,
    amount: order.side === 'buy' ? fillAmount : (order.price * fillAmount),
    status: 'completed',
    note: `Order filled: ${order.side.toUpperCase()} ${fillAmount} ${base} @ ${order.price} ${quote}`
  });

  await notify(user._id, 'system',
    'Order filled',
    `${order.side.toUpperCase()} ${fillAmount} ${base} @ ${order.price} ${quote}`);
}

module.exports = router;

const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    fullName: { type: String },
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    myReferralId: { type: String, unique: true, sparse: true },
    referredBy: { type: String, default: null },
    balance: { type: Number, default: 0 },
    taskEarnings: { type: Number, default: 0 },
    dailyEarnings: { type: Number, default: 0 },
    affiliateBalance: { type: Number, default: 0 },
    planActivated: { type: Boolean, default: false },
    activePackage: { type: String, default: 'None' },
    activePackageId: { type: String, default: null },
    role: { type: String, default: 'user' },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', UserSchema);
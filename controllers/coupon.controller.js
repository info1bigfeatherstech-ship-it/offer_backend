// controllers/coupon.controller.js
const Coupon = require('../models/Coupon');
const Cart = require('../models/cart');
const { evaluateCartForCheckout, couponUserEligible } = require('../services/checkoutComputation.service');

// ==================== ADMIN FUNCTIONS ====================

// CREATE COUPON (Admin only)
const createCoupon = async (req, res) => {
    try {
        const {
            code,
            name,
            description,
            discountType,
            discountValue,
            maxDiscountAmount,
            minOrderValue,
            applicableUsers,
            usageLimit,
            perUserLimit,
            expiryDate,
            isActive
        } = req.body;

        // Check if coupon code already exists
        const existingCoupon = await Coupon.findOne({ code: code.toUpperCase() });
        if (existingCoupon) {
            return res.status(400).json({
                success: false,
                message: 'Coupon code already exists'
            });
        }

        const coupon = new Coupon({
            code: code.toUpperCase(),
            name,
            description: description || '',
            discountType,
            discountValue,
            maxDiscountAmount: maxDiscountAmount || null,
            minOrderValue: minOrderValue || 0,
            applicableUsers: applicableUsers || ['user', 'wholesaler'],
            usageLimit: usageLimit || null,
            perUserLimit: perUserLimit || 1,
            expiryDate,
            isActive: isActive !== undefined ? isActive : true
        });

        await coupon.save();

        return res.status(201).json({
            success: true,
            message: 'Coupon created successfully',
            coupon
        });

    } catch (error) {
        console.error('Create coupon error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error creating coupon',
            error: error.message
        });
    }
};

// GET ALL COUPONS (Admin)
const getAllCoupons = async (req, res) => {
    try {
        const { page = 1, limit = 20, status } = req.query;
        const query = {};

        if (status === 'active') query.isActive = true;
        if (status === 'inactive') query.isActive = false;

        const coupons = await Coupon.find(query)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit));

        const total = await Coupon.countDocuments(query);

        return res.json({
            success: true,
            coupons,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Get coupons error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching coupons',
            error: error.message
        });
    }
};

// GET SINGLE COUPON (Admin)
const getCouponById = async (req, res) => {
    try {
        const { id } = req.params;
        const coupon = await Coupon.findById(id);

        if (!coupon) {
            return res.status(404).json({
                success: false,
                message: 'Coupon not found'
            });
        }

        return res.json({
            success: true,
            coupon
        });

    } catch (error) {
        console.error('Get coupon error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching coupon',
            error: error.message
        });
    }
};

// UPDATE COUPON (Admin)
const updateCoupon = async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        // Don't allow code change if already exists
        if (updates.code) {
            updates.code = updates.code.toUpperCase();
            const existing = await Coupon.findOne({ 
                code: updates.code, 
                _id: { $ne: id } 
            });
            if (existing) {
                return res.status(400).json({
                    success: false,
                    message: 'Coupon code already exists'
                });
            }
        }

        const coupon = await Coupon.findByIdAndUpdate(
            id,
            { $set: updates },
            { new: true, runValidators: true }
        );

        if (!coupon) {
            return res.status(404).json({
                success: false,
                message: 'Coupon not found'
            });
        }

        return res.json({
            success: true,
            message: 'Coupon updated successfully',
            coupon
        });

    } catch (error) {
        console.error('Update coupon error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error updating coupon',
            error: error.message
        });
    }
};

// DELETE COUPON (Admin)
const deleteCoupon = async (req, res) => {
    try {
        const { id } = req.params;
        const coupon = await Coupon.findByIdAndDelete(id);

        if (!coupon) {
            return res.status(404).json({
                success: false,
                message: 'Coupon not found'
            });
        }

        return res.json({
            success: true,
            message: 'Coupon deleted successfully'
        });

    } catch (error) {
        console.error('Delete coupon error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error deleting coupon',
            error: error.message
        });
    }
};

// TOGGLE COUPON STATUS (Activate/Deactivate)
const toggleCouponStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const coupon = await Coupon.findById(id);

        if (!coupon) {
            return res.status(404).json({
                success: false,
                message: 'Coupon not found'
            });
        }

        coupon.isActive = !coupon.isActive;
        await coupon.save();

        return res.json({
            success: true,
            message: `Coupon ${coupon.isActive ? 'activated' : 'deactivated'} successfully`,
            coupon
        });

    } catch (error) {
        console.error('Toggle coupon error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error toggling coupon status',
            error: error.message
        });
    }
};

// ==================== USER FUNCTIONS ====================

// VALIDATE COUPON (User - before checkout)
const validateCoupon = async (req, res) => {
    try {
        const { couponCode, subtotal, useServercart } = req.body;
        const userId = req.userId;
        const finalUserType = req.userType === 'wholesaler' ? 'wholesaler' : 'normal';

        if (!couponCode) {
            return res.status(400).json({
                success: false,
                message: 'Coupon code is required'
            });
        }

        let effectiveSubtotal = Number(subtotal);
        if (useServercart || subtotal === undefined || subtotal === null) {
            const cartDoc = await Cart.findOne({ userId });
            if (!cartDoc?.items?.length) {
                return res.status(400).json({
                    success: false,
                    message: 'cart is empty — add items before applying a coupon'
                });
            }
            const ev = await evaluateCartForCheckout(cartDoc, finalUserType, null, req.storefront || 'ecomm');
            effectiveSubtotal = ev.subtotal;
        }

        if (!Number.isFinite(effectiveSubtotal) || effectiveSubtotal < 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid cart subtotal'
            });
        }

        const coupon = await Coupon.findOne({ 
            code: couponCode.toUpperCase(), 
            isActive: true 
        });

        if (!coupon) {
            return res.status(404).json({
                success: false,
                message: 'Invalid coupon code'
            });
        }

        // Check expiry
        if (coupon.expiryDate < new Date()) {
            return res.status(400).json({
                success: false,
                message: 'Coupon has expired'
            });
        }

        // Check user eligibility (align with checkout / orders)
        if (!couponUserEligible(coupon, finalUserType)) {
            return res.status(400).json({
                success: false,
                message: 'Coupon not applicable for your account type'
            });
        }

        // Check minimum order value
        if (effectiveSubtotal < coupon.minOrderValue) {
            return res.status(400).json({
                success: false,
                message: `Minimum order value of ₹${coupon.minOrderValue} required to use this coupon`
            });
        }

        // Check usage limit
        if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
            return res.status(400).json({
                success: false,
                message: 'Coupon usage limit has been reached'
            });
        }

        // Check per user limit (you'll need a UserCouponUsage model for this)
        // For now, skip or implement later

        // Calculate discount amount
        let discountAmount = 0;
        if (coupon.discountType === 'percentage') {
            discountAmount = (effectiveSubtotal * coupon.discountValue) / 100;
            if (coupon.maxDiscountAmount && discountAmount > coupon.maxDiscountAmount) {
                discountAmount = coupon.maxDiscountAmount;
            }
        } else {
            discountAmount = coupon.discountValue;
        }

        discountAmount = Math.min(discountAmount, effectiveSubtotal);

        return res.json({
            success: true,
            valid: true,
            coupon: {
                code: coupon.code,
                name: coupon.name,
                discountType: coupon.discountType,
                discountValue: coupon.discountValue,
                discountAmount: Math.round(discountAmount),
                maxDiscountAmount: coupon.maxDiscountAmount,
                minOrderValue: coupon.minOrderValue,
                description: coupon.description
            }
        });

    } catch (error) {
        console.error('Validate coupon error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error validating coupon',
            error: error.message
        });
    }
};

// GET AVAILABLE COUPONS FOR USER
const getAvailableCoupons = async (req, res) => {
    try {
        const userType = req.userType === 'wholesaler' ? 'wholesaler' : 'user';
        const now = new Date();

        const applicableFilter =
            userType === 'wholesaler'
                ? { $in: ['wholesaler'] }
                : { $in: ['user', 'normal'] };

        const coupons = await Coupon.find({
            isActive: true,
            expiryDate: { $gt: now },
            applicableUsers: applicableFilter
        }).select('code name description discountType discountValue maxDiscountAmount minOrderValue expiryDate');

        return res.json({
            success: true,
            coupons
        });

    } catch (error) {
        console.error('Get available coupons error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching available coupons',
            error: error.message
        });
    }
};

module.exports = {
    // Admin
    createCoupon,
    getAllCoupons,
    getCouponById,
    updateCoupon,
    deleteCoupon,
    toggleCouponStatus,
    // User
    validateCoupon,
    getAvailableCoupons
};
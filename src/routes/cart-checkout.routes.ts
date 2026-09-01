import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { addCartItem, confirmPayment, createOrder, deleteCartItem, getCart, getOrder, getPaymentMethods, initPayment, resendPaymentOtp, syncCart, updateCartItem, validateCoupon } from '../controllers/cart-checkout.controller';

const router = Router();
const clientAuth = [authenticate, requireActiveUser, authorize(AccountType.CLIENT_COMPANY, AccountType.CLIENT_INDIVIDUAL)];

router.get('/cart', ...clientAuth, getCart);
router.post('/cart/items', ...clientAuth, addCartItem);
router.put('/cart/items/:id', ...clientAuth, updateCartItem);
router.delete('/cart/items/:id', ...clientAuth, deleteCartItem);
router.post('/cart/sync', ...clientAuth, syncCart);
router.post('/checkout/coupon/validate', ...clientAuth, validateCoupon);
router.post('/checkout/order', ...clientAuth, createOrder);
router.get('/checkout/order/:id', ...clientAuth, getOrder);
router.get('/checkout/payment/methods', ...clientAuth, getPaymentMethods);
router.post('/checkout/payment/init', ...clientAuth, initPayment);
router.post('/checkout/payment/confirm', ...clientAuth, confirmPayment);
router.post('/checkout/payment/resend-otp', ...clientAuth, resendPaymentOtp);

export default router;

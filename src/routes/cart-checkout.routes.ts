import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorizeActiveRoleWithMessage, requireActiveUser } from '../middlewares/auth.middleware';
import { paymentLimiter } from '../middlewares/rate-limit.middleware';
import { addCartItem, confirmPayment, createOrder, deleteCartItem, getCart, getOrder, getPaymentMethods, initPayment, resendPaymentOtp, syncCart, updateCartItem, validateCoupon } from '../controllers/cart-checkout.controller';

const router = Router();
// Buying is the CLIENT's flow: the role the user is ACTING as must be the client (activeRole), not merely a CLIENT entry in `roles` — every account also holds CLIENT.
// A provider acting as a provider can browse the marketplace but cannot add to the cart, create an order or pay; the client's wallet balance is never used from the provider role.
export const SWITCH_TO_CLIENT_TO_BUY = 'بدّل إلى حساب طالب الخدمة لإتمام الشراء';
const clientAuth = [authenticate, requireActiveUser, authorizeActiveRoleWithMessage(SWITCH_TO_CLIENT_TO_BUY, AccountType.CLIENT_COMPANY, AccountType.CLIENT_INDIVIDUAL)];

router.get('/cart', ...clientAuth, getCart);
router.post('/cart/items', ...clientAuth, addCartItem);
router.put('/cart/items/:id', ...clientAuth, updateCartItem);
router.delete('/cart/items/:id', ...clientAuth, deleteCartItem);
router.post('/cart/sync', ...clientAuth, syncCart);
router.post('/checkout/coupon/validate', ...clientAuth, validateCoupon);
router.post('/checkout/order', ...clientAuth, createOrder);
router.get('/checkout/order/:id', ...clientAuth, getOrder);
router.get('/checkout/payment/methods', ...clientAuth, getPaymentMethods);
router.post('/checkout/payment/init', ...clientAuth, paymentLimiter, initPayment);
router.post('/checkout/payment/confirm', ...clientAuth, paymentLimiter, confirmPayment);
router.post('/checkout/payment/resend-otp', ...clientAuth, paymentLimiter, resendPaymentOtp);

export default router;

import { prisma } from '../config/db';
import { allocateOrderDiscount, round2 } from '../utils/order-discount';
import { LEGACY_CURRENCY, sumByCurrency } from '../utils/currency';
import { platformCurrency } from './platform-currency';

// Provider sales = the provider's marketplace order items whose order has been paid (PAID / PROCESSING / COMPLETED). A provider coupon discounts the service value itself,
// so `amount` is the NET the client really paid for the item (list price − its share of the order discount, the same allocation checkout used).
const PAID_STATUSES = ['PAID', 'PROCESSING', 'COMPLETED'] as const;

export type SaleStatus = 'completed' | 'pending' | 'refunded';
const saleStatus = (orderStatus: string): SaleStatus => (orderStatus === 'COMPLETED' ? 'completed' : orderStatus === 'CANCELLED' ? 'refunded' : 'pending');

export class ProviderSalesService {
  async getSales(providerId: string) {
    const base = await platformCurrency(); // the headline currency: the platform base currency (other currencies are listed separately)
    const orders = await prisma.order.findMany({
      where: { status: { in: [...PAID_STATUSES] as any }, items: { some: { providerId } } },
      orderBy: { createdAt: 'desc' },
      include: { items: true, user: { select: { firstName: true, lastName: true } } }
    });
    // only paid orders are selected (PENDING_PAYMENT / CANCELLED never appear): there is no refund record to tell a refunded sale apart, so none is invented
    const sales = orders.flatMap(order => {
      const shares = allocateOrderDiscount(order.items.map(i => ({ id: i.id, serviceId: i.serviceId, price: i.price })), order.discount || 0, null);
      return order.items.filter(i => i.providerId === providerId).map(i => ({
        id: `${order.orderNumber}-${i.id.slice(0, 6)}`,
        orderNumber: order.orderNumber,
        modelId: i.serviceId ?? i.modelId,
        model: i.title,
        client: `${order.user?.firstName || ''} ${order.user?.lastName || ''}`.trim() || 'عميل',
        amount: round2(i.price - (shares.get(i.id) ?? 0)),
        currency: (order.currency ?? base) as string,
        date: order.createdAt.toISOString().slice(0, 10),
        createdAt: order.createdAt.toISOString(),
        status: saleStatus(order.status)
      }));
    });
    const counted = sales.filter(s => s.status !== 'refunded');
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    // the headline figures are the USD sales; every currency is also listed on its own (sales of different currencies are never added)
    const usdSales = counted.filter(s => s.currency === base);
    const totalBy = sumByCurrency(counted, s => s.currency, s => s.amount);
    const total = round2(usdSales.reduce((s, x) => s + x.amount, 0));
    const byModel = new Map<string, { name: string; sales: number; revenue: number }>();
    for (const s of usdSales) {
      const m = byModel.get(s.modelId) ?? { name: s.model, sales: 0, revenue: 0 };
      m.sales += 1; m.revenue = round2(m.revenue + s.amount); byModel.set(s.modelId, m);
    }
    const topModels = [...byModel.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5)
      .map(m => ({ ...m, pct: total > 0 ? Math.round((m.revenue / total) * 100) : 0 }));
    return {
      summary: {
        totalRevenue: total,
        monthRevenue: round2(usdSales.filter(s => new Date(s.createdAt) >= monthStart).reduce((s, x) => s + x.amount, 0)),
        totalRevenueBy: totalBy,
        monthRevenueBy: sumByCurrency(counted.filter(s => new Date(s.createdAt) >= monthStart), s => s.currency, s => s.amount),
        salesCount: counted.length,
        averageOrderValue: usdSales.length ? round2(total / usdSales.length) : 0,
        currency: base
      },
      topModels,
      sales: sales.slice(0, 50)
    };
  }
}

export const providerSalesService = new ProviderSalesService();

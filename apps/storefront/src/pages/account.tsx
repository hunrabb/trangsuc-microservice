import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import {
  accountOrderSchema as orderSchema,
  accountOrderPageSchema as pageSchema,
} from '@jewelry/contracts';
import {
  accountGet,
  loginAccount,
  logoutAccount,
  restoreAccount,
  useAccount,
} from '../api/account.ts';
import { money } from '../state/catalog.ts';
import { orderPollInterval, orderPresentation } from '../state/checkout.ts';
import { OrderStatus, PaymentGuidance } from './orders.tsx';
import { StatePanel } from '../components/ui.tsx';
export function AccountPage() {
  const { account, ready } = useAccount();
  const { orderId } = useParams();
  const client = useQueryClient();
  const [page, setPage] = useState(1);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  useEffect(() => {
    if (!ready) void restoreAccount();
  }, [ready]);
  const list = useQuery({
    queryKey: ['account-orders', account?.user.id, page],
    enabled: !!account && !orderId,
    queryFn: ({ signal }) => accountGet(`?page=${page}&pageSize=20`, pageSchema, signal),
  });
  const detail = useQuery({
    queryKey: ['account-orders', account?.user.id, orderId],
    enabled: !!account && !!orderId,
    queryFn: ({ signal }) => accountGet(`/${orderId}`, orderSchema, signal),
    refetchOnWindowFocus: true,
    refetchInterval: (query) => (query.state.error ? false : orderPollInterval(query.state.data)),
  });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const values = new FormData(event.currentTarget);
    try {
      await loginAccount(mode, {
        email: String(values.get('email')).trim(),
        password: String(values.get('password')),
        ...(mode === 'register' ? { fullName: String(values.get('fullName')).trim() } : {}),
      });
      client.removeQueries({ queryKey: ['account-orders'] });
      setPage(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Vui lòng thử lại.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="container tracking-page">
      <p className="eyebrow">TÀI KHOẢN CỦA TÔI</p>
      <h1>Đơn hàng của tôi</h1>
      {!ready ? (
        <StatePanel title="Đang kiểm tra phiên đăng nhập…" />
      ) : !account ? (
        <>
          <p>Đăng nhập để xem các đơn hàng bạn đã đặt bằng tài khoản.</p>
          <form className="access-form" onSubmit={submit}>
            <h2>{mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}</h2>
            {mode === 'register' && (
              <label className="field-label">
                Họ tên
                <input name="fullName" autoComplete="name" maxLength={150} required />
              </label>
            )}
            <label className="field-label">
              Email
              <input name="email" type="email" autoComplete="email" maxLength={254} required />
            </label>
            <label className="field-label">
              Mật khẩu
              <input
                name="password"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                minLength={mode === 'register' ? 12 : 1}
                maxLength={72}
                required
              />
            </label>
            {mode === 'register' && <p>Mật khẩu từ 12 ký tự, tối đa 72 byte.</p>}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <button className="button button-dark" disabled={busy}>
              {busy ? 'Đang xử lý…' : mode === 'login' ? 'Đăng nhập' : 'Đăng ký'}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setError('');
              }}
            >
              {mode === 'login' ? 'Chưa có tài khoản? Đăng ký' : 'Đã có tài khoản? Đăng nhập'}
            </button>
          </form>
          <p>
            <Link to="/don-hang/khach">Theo dõi đơn đã đặt không dùng tài khoản</Link>
          </p>
        </>
      ) : (
        <>
          <div className="tracking-heading">
            <p>Xin chào, {account.user.fullName}</p>
            <button
              className="button button-outline"
              onClick={async () => {
                try {
                  await logoutAccount();
                  await client.cancelQueries({ queryKey: ['account-orders'] });
                  client.removeQueries({ queryKey: ['account-orders'] });
                  setPage(1);
                } catch {
                  setError('Chưa đăng xuất được. Vui lòng thử lại.');
                }
              }}
            >
              Đăng xuất
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
          {orderId ? (
            <>
              <Link to="/tai-khoan/don-hang">← Danh sách đơn hàng</Link>
              {detail.isPending ? (
                <StatePanel title="Đang tải đơn hàng…" />
              ) : detail.isError ? (
                <StatePanel
                  title={detail.error.message}
                  action={
                    <button className="button button-outline" onClick={() => void detail.refetch()}>
                      Thử lại
                    </button>
                  }
                />
              ) : (
                <>
                  <p>
                    Mã đơn: {detail.data.code} · Ngày đặt:{' '}
                    {new Date(detail.data.createdAt).toLocaleString('vi-VN')}
                  </p>
                  {['PENDING', 'AWAITING_PAYMENT'].includes(detail.data.status) && (
                    <div className="cancel-order">
                      {!confirmCancel ? (
                        <button className="text-button" onClick={() => setConfirmCancel(true)}>
                          Tôi muốn huỷ yêu cầu này
                        </button>
                      ) : (
                        <>
                          <p>Bạn có chắc muốn huỷ yêu cầu đặt hàng này?</p>
                          <button
                            className="button button-outline"
                            disabled={busy}
                            onClick={async () => {
                              setBusy(true);
                              setError('');
                              try {
                                await accountGet(
                                  `/${orderId}/cancel`,
                                  orderSchema,
                                  undefined,
                                  'POST',
                                );
                                setConfirmCancel(false);
                                await client.invalidateQueries({
                                  queryKey: ['account-orders', account.user.id],
                                });
                              } catch (e) {
                                setError(
                                  e instanceof Error ? e.message : 'Chưa huỷ được đơn hàng.',
                                );
                              } finally {
                                setBusy(false);
                              }
                            }}
                          >
                            {busy ? 'Đang xử lý…' : 'Xác nhận huỷ'}
                          </button>
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => setConfirmCancel(false)}
                          >
                            Giữ đơn hàng
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  <OrderStatus order={detail.data} />
                  <PaymentGuidance order={detail.data} />
                  <section className="order-items">
                    <h2>Sản phẩm trong đơn</h2>
                    {detail.data.items.length === 0 && (
                      <p>Sản phẩm và đơn giá sẽ hiển thị sau khi kiểm tra giữ hàng.</p>
                    )}
                    {detail.data.items.map((item, i) => (
                      <div className="tracked-item" key={i}>
                        <div>
                          <h3>{item.productName}</h3>
                          <p>{item.sku} · Số lượng: 1</p>
                          <p>Đơn giá: {money(item.price)}</p>
                        </div>
                        <strong>{money(item.price)}</strong>
                      </div>
                    ))}
                    <div className="summary-total">
                      <span>Tổng tiền</span>
                      <strong>
                        {detail.data.total === null ? 'Chờ xác nhận giá' : money(detail.data.total)}
                      </strong>
                    </div>
                  </section>
                </>
              )}
            </>
          ) : list.isPending ? (
            <StatePanel title="Đang tải đơn hàng…" />
          ) : list.isError ? (
            <StatePanel
              title={list.error.message}
              action={
                <button className="button button-outline" onClick={() => void list.refetch()}>
                  Thử lại
                </button>
              }
            />
          ) : (
            <>
              {!list.data.items.length ? (
                <StatePanel
                  title="Bạn chưa có đơn hàng nào"
                  action={
                    <Link className="button button-dark" to="/bo-suu-tap">
                      Khám phá bộ sưu tập
                    </Link>
                  }
                />
              ) : (
                <div className="account-order-list">
                  {list.data.items.map((order) => (
                    <article className="order-items" key={order.id}>
                      <h2 className="breakable">{order.code}</h2>
                      <p>Ngày đặt: {new Date(order.createdAt).toLocaleString('vi-VN')}</p>
                      <p>{orderPresentation[order.status].title}</p>
                      <p>
                        Tổng tiền: {order.total === null ? 'Chờ xác nhận giá' : money(order.total)}
                      </p>
                      <Link
                        className="button button-outline"
                        to={`/tai-khoan/don-hang/${order.id}`}
                      >
                        Xem chi tiết
                      </Link>
                    </article>
                  ))}
                </div>
              )}
              {list.data.total > 20 && (
                <nav aria-label="Phân trang đơn hàng" className="tracking-heading">
                  <button
                    className="button button-outline"
                    disabled={page === 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Trang trước
                  </button>
                  <span>
                    Trang {page} / {Math.ceil(list.data.total / 20)}
                  </span>
                  <button
                    className="button button-outline"
                    disabled={page * 20 >= list.data.total}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Trang sau
                  </button>
                </nav>
              )}
              <p>
                <Link to="/don-hang/khach">Theo dõi đơn đã đặt không dùng tài khoản</Link>
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

import { DemoPayment } from '../components/demo-payment.tsx';
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { shopProductSchema } from '@jewelry/contracts';
import { shopApi, canRetryRead, failureText, type ShopOrder } from '../api/shop.ts';
import { orderPollInterval, orderPresentation, type CheckoutAttempt } from '../state/checkout.ts';
import { useStore } from '../state/store.tsx';
import { money } from '../state/catalog.ts';
import { Breadcrumb, Icon, StatePanel } from '../components/ui.tsx';

export function OrderStatus({ order }: { order: ShopOrder }) {
  const presentation = orderPresentation[order.status];
  const failure = failureText(order.failureCode);
  return (
    <section className={`order-status-card ${presentation.tone}`} aria-live="polite">
      <span className="status-emblem">
        <Icon name={order.status === 'CONFIRMED' ? 'check' : 'clock'} size={28} />
      </span>
      <p className="eyebrow">TRẠNG THÁI YÊU CẦU</p>
      <h1>{presentation.title}</h1>
      <p>{presentation.description}</p>
      {order.needsReview && !['PAYMENT_REVIEW', 'REFUND_PENDING'].includes(order.status) && (
        <p className="order-failure">
          Yêu cầu cần được cửa hàng kiểm tra thêm. Vui lòng giữ mã tra cứu và kiểm tra kết quả trước
          khi đặt đơn mới.
        </p>
      )}
      {failure && order.status === 'CANCELLED' && <p className="order-failure">{failure}</p>}
      {order.status === 'CANCELLED' &&
        order.failureCode === 'RESERVATION_EXPIRED' &&
        order.expiresAt && (
          <p className="order-failure">
            Đơn cũ đã hết hạn lúc{' '}
            {new Date(order.expiresAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}{' '}
            (giờ Việt Nam). Mở lại liên kết không bắt đầu lượt giữ hàng mới.
          </p>
        )}
      <ol className="order-timeline">
        {['Tiếp nhận yêu cầu', 'Giữ sản phẩm', 'Xác minh thanh toán', 'Xác nhận đơn'].map(
          (label, i) => (
            <li
              key={label}
              className={i <= presentation.step ? 'reached' : ''}
              aria-current={i === presentation.step ? 'step' : undefined}
            >
              <span>{i < presentation.step ? <Icon name="check" size={14} /> : `0${i + 1}`}</span>
              {label}
            </li>
          ),
        )}
      </ol>
    </section>
  );
}
export function PaymentGuidance({ order }: { order: ShopOrder }) {
  return <DemoPayment order={order} />;
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000));
  return (
    <div className="reservation-clock">
      <Icon name="clock" size={20} />
      <div>
        <span>Thời gian giữ sản phẩm còn lại</span>
        <strong>
          {Math.floor(seconds / 60)
            .toString()
            .padStart(2, '0')}
          :{(seconds % 60).toString().padStart(2, '0')}
        </strong>
        {seconds === 0 && (
          <p>Thời gian hiển thị đã kết thúc. Vui lòng cập nhật để kiểm tra trạng thái đơn.</p>
        )}
      </div>
    </div>
  );
}
function AccessForm({ initialId = '' }: { initialId?: string }) {
  const { vault, refreshSession } = useStore();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const id = String(data.get('orderId')).trim();
      vault.importAccess(id, String(data.get('token')));
      refreshSession();
      navigate(`/don-hang/${id}`);
    } catch {
      setError(
        'Vui lòng kiểm tra ID trong liên kết đơn, mã truy cập riêng và quyền lưu phiên của trình duyệt.',
      );
    }
  }
  return (
    <form className="access-form" onSubmit={submit}>
      <h2>Tra cứu trên trình duyệt này</h2>
      <p>Dùng ID trong liên kết đơn và mã truy cập riêng đã lưu của bạn.</p>
      <label className="field-label">
        ID tra cứu đơn
        <input name="orderId" defaultValue={initialId} autoComplete="off" required />
      </label>
      <label className="field-label">
        Mã truy cập riêng
        <input name="token" type="password" autoComplete="off" spellCheck={false} required />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="button button-dark" type="submit">
        Tra cứu đơn <Icon name="arrow" size={16} />
      </button>
    </form>
  );
}
function TrackedOrder({ attempt }: { attempt: CheckoutAttempt }) {
  const store = useStore(),
    client = useQueryClient(),
    navigate = useNavigate();
  const [notice, setNotice] = useState(''),
    [confirmCancel, setConfirmCancel] = useState(false),
    [cancelling, setCancelling] = useState(false);
  const [expired, setExpired] = useState(() => attempt.expiresAt <= Date.now());
  const [showAccess, setShowAccess] = useState(false);
  const queryKey = ['private-order', attempt.id, attempt.orderId];
  useEffect(() => {
    const timer = setTimeout(
      () => {
        setExpired(true);
        store.vault.list();
        client.removeQueries({ queryKey: ['private-order', attempt.id, attempt.orderId] });
      },
      Math.max(0, attempt.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [attempt.id, attempt.orderId, attempt.expiresAt, client, store.vault]);
  const order = useQuery({
    queryKey,
    enabled: !expired,
    queryFn: ({ signal }) => {
      if (attempt.expiresAt <= Date.now()) throw new Error('Quyền tra cứu trong tab đã hết hạn.');
      return shopApi.order(attempt.orderId!, attempt.token, signal);
    },
    gcTime: 0,
    staleTime: 0,
    retry: canRetryRead,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => (query.state.error ? false : orderPollInterval(query.state.data)),
  });
  useEffect(() => {
    if (order.data && !expired) {
      try {
        store.vault.known(attempt, order.data);
      } catch {
        /* Token ban đầu vẫn được giữ; không tiết lộ qua log. */
      }
    }
  }, [order.data, store.vault, attempt, expired]);
  async function cancel() {
    if (
      attempt.expiresAt <= Date.now() ||
      cancelling ||
      !order.data ||
      !['PENDING', 'AWAITING_PAYMENT'].includes(order.data.status)
    )
      return;
    setCancelling(true);
    setNotice('');
    try {
      const result = await shopApi.cancel(order.data.id, attempt.token);
      client.setQueryData(queryKey, result);
      setConfirmCancel(false);
    } catch {
      setNotice(
        'Chưa xác định được kết quả huỷ. Vui lòng cập nhật đơn trước khi thử lại; trạng thái trước đó vẫn được giữ để bạn đối chiếu.',
      );
      void order.refetch();
    } finally {
      setCancelling(false);
    }
  }
  if (expired)
    return (
      <StatePanel
        title="Quyền tra cứu trong tab đã hết hạn"
        action={
          <Link className="button button-dark" to="/don-hang">
            Mở lại bằng mã đã lưu riêng
          </Link>
        }
      >
        Thông tin đơn đã được ẩn khỏi phiên này. Thời hạn này không thay đổi trạng thái đặt hàng
        hoặc thanh toán.
      </StatePanel>
    );
  if (order.isPending)
    return <StatePanel title="Đang kiểm tra đơn của bạn">Vui lòng chờ trong giây lát.</StatePanel>;
  if (!order.data)
    return (
      <StatePanel
        title="Chưa thể truy cập đơn"
        kind="error"
        action={
          <>
            <button className="button button-dark" onClick={() => void order.refetch()}>
              Kiểm tra lại
            </button>
            <Link className="button button-outline" to="/don-hang">
              Dùng quyền truy cập khác
            </Link>
          </>
        }
      >
        Liên kết và mã truy cập phải thuộc cùng một đơn. Kết nối gián đoạn cũng có thể làm việc tra
        cứu chưa thực hiện được.
      </StatePanel>
    );
  const data = order.data;
  return (
    <>
      <div className="tracking-heading">
        <div>
          <p className="eyebrow">ĐƠN CỦA BẠN</p>
          <p className="order-code">{data.code}</p>
        </div>
        <button
          className="button button-outline"
          disabled={order.isFetching}
          onClick={() => void order.refetch()}
        >
          {order.isFetching ? 'Đang cập nhật…' : 'Cập nhật trạng thái'}
        </button>
      </div>
      {order.isError && (
        <p className="notice warning" role="alert">
          Chưa cập nhật được trạng thái mới. Thông tin dưới đây là lần kiểm tra gần nhất.
        </p>
      )}
      <OrderStatus order={data} />
      <div className="tracking-grid">
        <div>
          <PaymentGuidance order={data} />
          {data.status === 'AWAITING_PAYMENT' && data.expiresAt && (
            <Countdown expiresAt={data.expiresAt} />
          )}
          <section className="order-items">
            <h2>Sản phẩm trong đơn</h2>
            {data.items.length ? (
              data.items.map((item, i) => (
                <div className="tracked-item" key={i}>
                  <span className="tracked-item-icon">
                    <Icon name="diamond" size={24} />
                  </span>
                  <div>
                    <h3>{item.productName}</h3>
                    <p>{item.sku} · 1 chiếc</p>
                  </div>
                  <strong>{money(item.price)}</strong>
                </div>
              ))
            ) : (
              <p>Các sản phẩm và giá đơn sẽ hiển thị sau khi kiểm tra giữ hàng.</p>
            )}
            <div className="summary-total">
              <span>Tổng tiền đơn</span>
              <strong>{data.total === null ? 'Chờ xác nhận giá' : money(data.total)}</strong>
            </div>
          </section>
        </div>
        <aside className="access-note">
          <Icon name="shield" size={25} />
          <h2>Giữ quyền tra cứu riêng tư</h2>
          <p>
            Quyền truy cập lưu trong tab này tối đa 72 giờ. Nếu đóng tab hoặc chuyển thiết bị, bạn
            cần mã truy cập riêng để mở lại đơn.
          </p>
          <button
            className="button button-outline full-width"
            onClick={async () => {
              try {
                if (attempt.expiresAt <= Date.now()) {
                  setExpired(true);
                  return;
                }
                await navigator.clipboard.writeText(attempt.token);
                setNotice(
                  'Đã sao chép mã truy cập. Hãy lưu riêng, không chia sẻ cùng liên kết đơn.',
                );
              } catch {
                setNotice(
                  'Trình duyệt chưa cho phép sao chép. Bạn có thể hiện mã để tự lưu riêng hoặc giữ tab này để theo dõi đơn.',
                );
              }
            }}
          >
            Sao chép mã truy cập riêng
          </button>
          <div className="manual-access">
            <button
              className="text-button"
              aria-expanded={showAccess}
              aria-controls="private-access-backup"
              onClick={() => {
                if (attempt.expiresAt <= Date.now()) {
                  setExpired(true);
                  return;
                }
                setShowAccess(!showAccess);
              }}
            >
              {showAccess ? 'Ẩn mã truy cập' : 'Hiện mã để tự lưu riêng'}
            </button>
            <div id="private-access-backup" hidden={!showAccess}>
              {showAccess && (
                <label className="field-label">
                  Mã truy cập riêng
                  <textarea
                    readOnly
                    rows={3}
                    value={attempt.token}
                    spellCheck={false}
                    autoComplete="off"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <span className="fine-print">
                    Chọn và sao chép bằng trình duyệt. Mã này mở được đơn của bạn; hãy lưu riêng và
                    ẩn mã khi đã xong.
                  </span>
                </label>
              )}
            </div>
          </div>
          {['PENDING', 'AWAITING_PAYMENT'].includes(data.status) && (
            <div className="cancel-order">
              {!confirmCancel ? (
                <button className="text-button" onClick={() => setConfirmCancel(true)}>
                  Tôi muốn huỷ yêu cầu này
                </button>
              ) : (
                <>
                  <p>Huỷ yêu cầu sẽ đề nghị cửa hàng ngừng giữ sản phẩm cho đơn.</p>
                  <button
                    className="button button-outline full-width"
                    disabled={cancelling}
                    onClick={() => void cancel()}
                  >
                    {cancelling ? 'Đang gửi yêu cầu huỷ…' : 'Xác nhận huỷ yêu cầu'}
                  </button>
                  <button className="text-button" onClick={() => setConfirmCancel(false)}>
                    Giữ lại yêu cầu
                  </button>
                </>
              )}
            </div>
          )}
          {['CANCELLED', 'CONFIRMED'].includes(data.status) && (
            <button
              className="text-button"
              onClick={() => {
                try {
                  store.vault.startNew();
                  store.refreshSession();
                  navigate('/gio-hang');
                } catch {
                  setNotice(
                    'Bạn còn một yêu cầu chưa xác định kết quả. Hãy kiểm tra tại trang đặt hàng trước.',
                  );
                }
              }}
            >
              Quay lại giỏ để đặt một đơn khác <Icon name="arrow" size={14} />
            </button>
          )}
        </aside>
      </div>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
    </>
  );
}
export function OrdersPage() {
  const { orderId } = useParams();
  const store = useStore();
  const attempts = store.vault.list();
  const valid = orderId ? shopProductSchema.shape.id.safeParse(orderId).success : true;
  const attempt = orderId ? store.vault.forOrder(orderId) : undefined;
  return (
    <div className="container tracking-page">
      <Breadcrumb
        items={[
          { label: 'Đơn của tôi', to: orderId ? '/don-hang' : undefined },
          ...(orderId ? [{ label: 'Theo dõi đơn' }] : []),
        ]}
      />
      {orderId && valid && attempt ? (
        <TrackedOrder key={attempt.id} attempt={attempt} />
      ) : (
        <>
          <div className="page-intro compact">
            <p className="eyebrow">YOUR ORDER</p>
            <h1>
              Theo dõi từng bước,
              <br />
              <em>an tâm hơn.</em>
            </h1>
            <p>Thông tin đơn chỉ mở được bằng quyền truy cập riêng của bạn.</p>
          </div>
          {!valid && (
            <p className="notice warning">Liên kết tra cứu chưa hợp lệ. Vui lòng kiểm tra lại.</p>
          )}
          {attempts.length > 0 && (
            <section className="recent-orders">
              <h2>Yêu cầu trong tab này</h2>
              {attempts.map((saved) => (
                <Link
                  key={saved.id}
                  to={saved.orderId ? `/don-hang/${saved.orderId}` : '/dat-hang'}
                >
                  <span>
                    <Icon name="bag" size={22} />
                    {saved.lastStatus
                      ? orderPresentation[saved.lastStatus].title
                      : 'Yêu cầu cần kiểm tra kết quả'}
                  </span>
                  <Icon name="arrow" size={17} />
                </Link>
              ))}
            </section>
          )}
          <AccessForm initialId={valid ? orderId : ''} />
          <p className="fine-print">
            Không đưa mã truy cập vào đường dẫn hoặc chia sẻ công khai. Mã truy cập không phải mã
            tham chiếu chuyển khoản.
          </p>
        </>
      )}
    </div>
  );
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AuthSession } from '@jewelry/contracts';
import { createApiClient } from './api-client.ts';
import { ApiError } from './api-error.ts';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const errorBody = (code: string) => ({ code, message: code, correlationId: 'test' });

const sessionWith = (accessToken: string): AuthSession => ({
  accessToken,
  expiresIn: 900,
  user: {
    id: '0f6f8f1e-5b8b-4f55-9a52-0d8d6f3a7a11',
    email: 'a@b.vn',
    fullName: 'A',
    branches: [],
  },
});

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface Setup {
  /** Token nào còn hạn; token khác (ví dụ `cu`) bị trả `401 TOKEN_EXPIRED`. */
  validToken?: string;
  /** Mỗi phần tử là phản hồi của một lần gọi refresh; hết thì trả token mới. */
  refreshReplies?: (() => Response)[];
  /** Gọi `/api/slow` với token hết hạn: chờ cổng này mở rồi mới trả 401. */
  gate?: Promise<void>;
}

/** Server giả: đếm số lần gọi, ghi lại header Authorization. */
function setup({ validToken = 'moi', refreshReplies = [], gate }: Setup = {}) {
  const calls = { refresh: 0, data: 0 };
  const authorizations: (string | null)[] = [];
  let lost = 0;
  let forbidden = 0;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const headers = new Headers(init?.headers);
    if (path === '/api/auth/refresh') {
      calls.refresh += 1;
      await wait(15);
      const reply = refreshReplies.shift();
      return reply === undefined ? json(200, sessionWith(validToken)) : reply();
    }
    calls.data += 1;
    authorizations.push(headers.get('authorization'));
    if (path === '/api/forbidden') {
      return json(403, errorBody('FORBIDDEN'));
    }
    const token = headers.get('authorization')?.replace('Bearer ', '');
    if (token === validToken) {
      return json(200, { ok: true });
    }
    if (path === '/api/slow') {
      await gate;
    }
    return json(401, errorBody(token === 'hong' ? 'INVALID_TOKEN' : 'TOKEN_EXPIRED'));
  };
  const client = createApiClient({
    fetch: fakeFetch as typeof fetch,
    onSessionLost: () => (lost += 1),
    onForbidden: () => (forbidden += 1),
    schedule: () => () => undefined,
  });
  return { client, calls, authorizations, lost: () => lost, forbidden: () => forbidden };
}

describe('bộ gọi API: phiên và refresh', () => {
  it('nhiều request cùng gặp TOKEN_EXPIRED: chỉ MỘT lần refresh, rồi cả năm gửi lại thành công', async () => {
    const { client, calls, authorizations } = setup();
    client.setSession(sessionWith('cu'));

    const results = await Promise.all(
      Array.from({ length: 5 }, () => client.request<{ ok: boolean }>('/api/data')),
    );

    assert.deepEqual(
      results,
      Array.from({ length: 5 }, () => ({ ok: true })),
    );
    assert.equal(calls.refresh, 1);
    assert.equal(calls.data, 10, '5 lần bị từ chối và 5 lần gửi lại');
    assert.equal(authorizations.filter((value) => value === 'Bearer moi').length, 5);
  });

  it('request nhận 401 SAU khi refresh đã xong: gửi lại bằng token mới, không refresh thêm', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((done) => (open = done));
    const { client, calls } = setup({ gate });
    client.setSession(sessionWith('cu'));

    const slow = client.request('/api/slow');
    await client.request('/api/data');
    assert.equal(calls.refresh, 1);
    open();
    await slow;

    assert.equal(calls.refresh, 1);
  });

  it('REFRESH_CONFLICT: thử refresh lại một lần rồi thành công', async () => {
    const { client, calls } = setup({
      refreshReplies: [() => json(409, errorBody('REFRESH_CONFLICT'))],
    });
    client.setSession(sessionWith('cu'));

    assert.deepEqual(await client.request('/api/data'), { ok: true });
    assert.equal(calls.refresh, 2);
  });

  it('REFRESH_CONFLICT lần thứ hai: dừng, không thử mãi; phiên vẫn còn', async () => {
    const conflict = () => json(409, errorBody('REFRESH_CONFLICT'));
    const { client, calls, lost } = setup({ refreshReplies: [conflict, conflict] });
    client.setSession(sessionWith('cu'));

    await assert.rejects(
      client.request('/api/data'),
      (error: ApiError) => error.code === 'REFRESH_CONFLICT',
    );
    assert.equal(calls.refresh, 2);
    assert.equal(lost(), 0);
  });

  it('INVALID_TOKEN: xoá token, báo về trang đăng nhập, KHÔNG gọi refresh', async () => {
    const { client, calls, lost } = setup();
    client.setSession(sessionWith('hong'));

    await assert.rejects(
      client.request('/api/data'),
      (error: ApiError) => error.code === 'INVALID_TOKEN',
    );

    assert.equal(calls.refresh, 0);
    assert.equal(lost(), 1);
    assert.equal(client.hasSession(), false);
  });

  it('refresh trả SESSION_EXPIRED: mất phiên, báo về trang đăng nhập', async () => {
    const { client, calls, lost } = setup({
      refreshReplies: [() => json(401, errorBody('SESSION_EXPIRED'))],
    });
    client.setSession(sessionWith('cu'));

    await assert.rejects(
      client.request('/api/data'),
      (error: ApiError) => error.code === 'SESSION_EXPIRED',
    );
    assert.equal(calls.refresh, 1);
    assert.equal(lost(), 1);
    assert.equal(client.hasSession(), false);
  });

  it('refresh đang chạy không khôi phục session sau khi người dùng đăng xuất', async () => {
    let refreshStarted: () => void = () => undefined;
    let completeRefresh: (response: Response) => void = () => undefined;
    const started = new Promise<void>((resolve) => (refreshStarted = resolve));
    const delayedRefresh = new Promise<Response>((resolve) => (completeRefresh = resolve));
    const client = createApiClient({
      fetch: async (input, init) => {
        if (String(input) === '/api/auth/refresh') {
          refreshStarted();
          return delayedRefresh;
        }
        const token = new Headers(init?.headers).get('authorization');
        return token === 'Bearer moi'
          ? json(200, { ok: true })
          : json(401, errorBody('TOKEN_EXPIRED'));
      },
      onSessionLost: () => undefined,
      onForbidden: () => undefined,
      schedule: () => () => undefined,
    });
    client.setSession(sessionWith('cu'));

    const pending = client.request('/api/data');
    await started;
    client.clearSession();
    completeRefresh(json(200, sessionWith('moi')));

    await assert.rejects(pending);
    assert.equal(client.hasSession(), false);
  });

  it('403: báo giao diện tải lại /me, giữ nguyên phiên', async () => {
    const { client, forbidden, lost } = setup();
    client.setSession(sessionWith('moi'));

    await assert.rejects(
      client.request('/api/forbidden'),
      (error: ApiError) => error.status === 403,
    );
    assert.equal(forbidden(), 1);
    assert.equal(lost(), 0);
    assert.equal(client.hasSession(), true);
  });
});

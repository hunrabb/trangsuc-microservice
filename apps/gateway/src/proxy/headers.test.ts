import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { forwardRequestHeaders, forwardResponseHeaders } from './headers.ts';

describe('forwardRequestHeaders', () => {
  it('xoá x-user-*, hop-by-hop, header do Connection liệt kê; giữ Authorization, Content-Type', () => {
    const headers = forwardRequestHeaders(
      {
        authorization: 'Bearer t',
        'content-type': 'application/json',
        cookie: 'a=1',
        'x-user-id': '1',
        'x-user-role': 'ADMIN',
        'X-USER-BRANCH': '2',
        connection: 'keep-alive, X-Bi-Mat',
        'x-bi-mat': '1',
        'keep-alive': 'timeout=5',
        te: 'trailers',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        'proxy-authorization': 'x',
        host: 'gateway',
        'content-length': '5',
        expect: '100-continue',
        'x-correlation-id': 'gia-mao',
      },
      'id-that',
    );
    assert.deepEqual(headers, {
      authorization: 'Bearer t',
      'content-type': 'application/json',
      cookie: 'a=1',
      'x-correlation-id': 'id-that',
    });
  });
});

describe('x-forwarded-for', () => {
  it('bỏ giá trị client tự gửi, đặt lại theo địa chỉ thật của kết nối', () => {
    const headers = forwardRequestHeaders({ 'x-forwarded-for': '1.2.3.4' }, 'id', '10.0.0.5');
    assert.equal(headers['x-forwarded-for'], '10.0.0.5');
    assert.equal(
      forwardRequestHeaders({ 'x-forwarded-for': '1.2.3.4' }, 'id')['x-forwarded-for'],
      undefined,
    );
  });
});

describe('forwardResponseHeaders', () => {
  it('giữ set-cookie thành nhiều dòng, bỏ header không còn đúng sau khi fetch giải nén', () => {
    const upstream = new Headers({
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': '10',
      'transfer-encoding': 'chunked',
      'x-correlation-id': 'khac',
    });
    upstream.append('set-cookie', 'a=1');
    upstream.append('set-cookie', 'b=2');
    assert.deepEqual(forwardResponseHeaders(upstream), {
      'content-type': 'application/json',
      'set-cookie': ['a=1', 'b=2'],
    });
  });
});

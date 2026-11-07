/** Client ID của Google (công khai). `.env.example` dùng giá trị mẫu, coi như chưa cấu hình. */
const raw = String(import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim();

export const GOOGLE_CLIENT_ID: string | undefined =
  raw === '' || raw.startsWith('dien-client-id') ? undefined : raw;

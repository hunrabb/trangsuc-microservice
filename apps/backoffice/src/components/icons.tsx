import type { ReactNode } from 'react';

/**
 * Bộ biểu tượng nét đơn giản vẽ bằng SVG, đủ cho menu và nút. Tự vẽ để khỏi thêm thư viện biểu tượng
 * (vài trăm KB) chỉ cho chừng chục hình. Màu theo `currentColor` nên đổi theo chữ của nút hay mục menu.
 */
interface IconProps {
  size?: number;
}

const icon = (paths: ReactNode) =>
  function Icon({ size = 18 }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {paths}
      </svg>
    );
  };

export const HomeIcon = icon(
  <>
    <path d="M4 11l8-7 8 7" />
    <path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9" />
    <path d="M10 20v-5h4v5" />
  </>,
);

export const StoreIcon = icon(
  <>
    <path d="M4 9l1.5-5h13L20 9" />
    <path d="M4 9a2.67 2.67 0 0 0 5.33 0a2.67 2.67 0 0 0 5.34 0a2.67 2.67 0 0 0 5.33 0" />
    <path d="M5 12v8h14v-8" />
    <path d="M10 20v-4h4v4" />
  </>,
);

export const UsersIcon = icon(
  <>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M3 20v-1.5a4.5 4.5 0 0 1 4.5-4.5h3a4.5 4.5 0 0 1 4.5 4.5V20" />
    <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8" />
    <path d="M21 20v-1.5a4.5 4.5 0 0 0-3-4.2" />
  </>,
);

export const KeyIcon = icon(
  <>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l8-8" />
    <path d="M16 7l3 3" />
    <path d="M13.5 9.5l2 2" />
  </>,
);

export const LogoutIcon = icon(
  <>
    <path d="M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2" />
    <path d="M10 12h10" />
    <path d="M17 9l3 3-3 3" />
  </>,
);

export const PlusIcon = icon(
  <>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </>,
);

/** Viên kim cương: dấu hiệu của thương hiệu ở thanh trên và trang đăng nhập. */
export const GemIcon = icon(
  <>
    <path d="M6 4h12l3 5-9 11L3 9z" />
    <path d="M3 9h18" />
    <path d="M9 4l-1.5 5L12 20l4.5-11L15 4" />
  </>,
);

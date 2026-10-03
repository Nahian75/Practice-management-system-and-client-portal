import { SetMetadata } from '@nestjs/common';

export type Access = 'public' | 'staff' | 'client' | 'any';

export const ACCESS_KEY = 'access';

/** No session needed. Use sparingly: sign-in, health checks. */
export const Public = () => SetMetadata(ACCESS_KEY, 'public' satisfies Access);
/** Signed-in staff only. */
export const StaffOnly = () => SetMetadata(ACCESS_KEY, 'staff' satisfies Access);
/** Signed-in clients only. */
export const ClientOnly = () => SetMetadata(ACCESS_KEY, 'client' satisfies Access);
/** Any signed-in account, staff or client. */
export const AnyAccount = () => SetMetadata(ACCESS_KEY, 'any' satisfies Access);

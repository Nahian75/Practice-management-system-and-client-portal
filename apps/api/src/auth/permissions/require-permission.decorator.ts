import { applyDecorators, SetMetadata } from '@nestjs/common';
import { StaffOnly } from '../sessions/access.decorators.js';
import type { Permission } from './permissions.js';

export const PERMISSION_KEY = 'permission';

/** Signed-in staff holding the permission. Implies @StaffOnly(), so the two cannot disagree. */
export const RequirePermission = (permission: Permission) =>
  applyDecorators(StaffOnly(), SetMetadata(PERMISSION_KEY, permission));

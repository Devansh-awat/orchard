import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const REQUIRES_AUTH_KEY = 'requiresAuth';
export const Auth = () => SetMetadata(REQUIRES_AUTH_KEY, true);

export const REQUIRES_SUPERADMIN_KEY = 'requires_superadmin';
export const SuperAdmin = () => SetMetadata(REQUIRES_SUPERADMIN_KEY, true);

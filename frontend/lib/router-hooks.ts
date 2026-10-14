import { useMemo } from 'react';
import { useLocation, useNavigate, useParams as useRouteParams } from 'react-router-dom';

export function usePathname() {
  return useLocation().pathname;
}

export function useParams<T extends Record<string, string | undefined>>() {
  return useRouteParams() as T;
}

export function useRouter() {
  const navigate = useNavigate();
  return useMemo(() => ({
    push: (path: string) => navigate(path),
    replace: (path: string) => navigate(path, { replace: true }),
  }), [navigate]);
}

export class RouteNotFoundError extends Error {
  constructor() {
    super('Route not found');
    this.name = 'RouteNotFoundError';
  }
}

export function notFound(): never {
  throw new RouteNotFoundError();
}
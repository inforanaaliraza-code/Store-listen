import { Component, lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { OpsShell } from './app/components/ops-shell';
import NotFoundPage from './app/not-found';
import ErrorPage from './app/error';
import DevcoreLayout from './app/devcore/layout';
import StudioLayout from './app/devcore/app/layout';
import { RouteNotFoundError } from './lib/router-hooks';
import './app/globals.css';

type PageComponent = ComponentType<any>;
type PageModule = { default: PageComponent };

const pageModules = import.meta.glob<PageModule>('./app/**/page.tsx');
const pages = Object.entries(pageModules).map(([source, load]) => {
  const pathParts = source
    .replace(/^\.\/app\//, '')
    .replace(/\/page\.tsx$/, '')
    .replace(/^page\.tsx$/, '')
    .split('/')
    .filter((part) => part && !/^\(.+\)$/.test(part))
    .map((part) => part.match(/^\[(.+)\]$/)?.[1] ? `:${part.slice(1, -1)}` : part);

  return {
    path: `/${pathParts.join('/')}`,
    isOps: source.includes('/(ops)/'),
    isDevcore: source.includes('/devcore/'),
    isStudio: source.includes('/devcore/app/'),
    Page: lazy(load),
  };
});

class RouteBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (error instanceof RouteNotFoundError) return <NotFoundPage />;
    return <ErrorPage error={error} reset={() => this.setState({ error: null })} />;
  }
}

function PageRoute({ page }: { page: typeof pages[number] }) {
  const params = useParams();
  const location = useLocation();
  const content = (
    <RouteBoundary key={location.pathname}>
      <Suspense fallback={<div className="main"><div className="skeleton" /></div>}>
        <page.Page params={params} />
      </Suspense>
    </RouteBoundary>
  );

  if (page.isOps) return <OpsShell>{content}</OpsShell>;
  if (page.isStudio) return <DevcoreLayout><StudioLayout>{content}</StudioLayout></DevcoreLayout>;
  if (page.isDevcore) return <DevcoreLayout>{content}</DevcoreLayout>;
  return content;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {pages.map((page) => <Route key={page.path} path={page.path} element={<PageRoute page={page} />} />)}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
import { createRootRoute, Link, Outlet } from '@tanstack/react-router';

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <div className="min-h-screen">
      <nav className="flex gap-4 border-b border-gray-200 p-4">
        <Link to="/" className="font-medium [&.active]:underline">
          Home
        </Link>
      </nav>
      <main className="p-4">
        <Outlet />
      </main>
    </div>
  );
}

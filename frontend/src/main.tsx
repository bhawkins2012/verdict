import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import './index.css'

import { AppLayout } from './components/layout/AppLayout'
import { AuthLayout } from './components/layout/AuthLayout'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { DashboardPage } from './pages/DashboardPage'
import { DiscoverPage } from './pages/DiscoverPage'
import { ProductPage } from './pages/ProductPage'
import { ReviewThreadPage } from './pages/ReviewThreadPage'
import { WriteReviewPage } from './pages/WriteReviewPage'
import { RecommendationsPage } from './pages/RecommendationsPage'
import { ProfilePage } from './pages/ProfilePage'
import { VerifyEmailPage } from './pages/VerifyEmailPage'
import { CategoryPage } from './pages/CategoryPage'
import { AdminCategoriesPage } from './pages/admin/AdminCategoriesPage'
import { AdminCategoryPage } from './pages/admin/AdminCategoryPage'
import { AdminProductLeversPage } from './pages/admin/AdminProductLeversPage'
import { useAuthStore } from './store/authStore'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, retry: 1 },
  }
})

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthStore()
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}

/** Hides admin pages from non-admins. Cosmetic only: the API checks the role on every admin request. */
function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuthStore()
  if (user?.role !== 'ADMIN') return <Navigate to="/dashboard" replace />
  return <>{children}</>
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* Public auth routes */}
          <Route element={<AuthLayout />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            {/* Public: the link may be opened on a device where the user is not signed in. */}
            <Route path="/verify-email" element={<VerifyEmailPage />} />
          </Route>

          {/* Protected app routes */}
          <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/discover" element={<DiscoverPage />} />
            <Route path="/products/:id" element={<ProductPage />} />
            <Route path="/products/:id/thread" element={<ReviewThreadPage />} />
            <Route path="/products/:id/review" element={<WriteReviewPage />} />
            <Route path="/recommendations" element={<RecommendationsPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/categories/:slug" element={<CategoryPage />} />
            <Route path="/admin" element={<AdminRoute><AdminCategoriesPage /></AdminRoute>} />
            <Route path="/admin/categories/:id" element={<AdminRoute><AdminCategoryPage /></AdminRoute>} />
            <Route path="/admin/products/:id" element={<AdminRoute><AdminProductLeversPage /></AdminRoute>} />
          </Route>

          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
)

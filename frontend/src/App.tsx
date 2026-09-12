import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { AppShell } from './AppShell'
import { GuestRoute, ProtectedRoute } from './routes/guards'
import { LoginScreen } from './screens/LoginScreen'
import { NotFoundScreen } from './screens/NotFoundScreen'
import { DashboardScreen } from './screens/DashboardScreen'
import { RegisterScreen } from './screens/RegisterScreen'

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route
              path="/login"
              element={
                <GuestRoute>
                  <LoginScreen />
                </GuestRoute>
              }
            />
            <Route
              path="/register"
              element={
                <GuestRoute>
                  <RegisterScreen />
                </GuestRoute>
              }
            />
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <DashboardScreen />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<NotFoundScreen />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}

export default App
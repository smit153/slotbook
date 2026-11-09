import type { RouteObject } from 'react-router';
import { Home, NotFound } from './guest/NotFound.js';
import { BookingPage } from './guest/BookingPage.js';
import { ManagePage } from './guest/ManagePage.js';
import { WaitlistPage } from './guest/WaitlistPage.js';
import { Login } from './host/Login.js';
import { DashboardLayout } from './host/DashboardLayout.js';
import { Bookings } from './host/Bookings.js';
import { EventTypes } from './host/EventTypes.js';
import { Availability } from './host/Availability.js';
import { Settings } from './host/Settings.js';
import { Notifications } from './host/Notifications.js';

/** Shared by the browser router (main.tsx) and the memory router in the web tests. */
export const routes: RouteObject[] = [
  { path: '/', element: <Home /> },
  { path: '/login', element: <Login /> },
  {
    path: '/dashboard',
    element: <DashboardLayout />,
    children: [
      { index: true, element: <Bookings /> },
      { path: 'event-types', element: <EventTypes /> },
      { path: 'availability', element: <Availability /> },
      { path: 'settings', element: <Settings /> },
      { path: 'notifications', element: <Notifications /> },
    ],
  },
  { path: '/manage', element: <ManagePage /> },
  { path: '/waitlist', element: <WaitlistPage /> },
  { path: '/:host/:slug', element: <BookingPage /> },
  { path: '*', element: <NotFound /> },
];

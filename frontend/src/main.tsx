import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./app/globals.css";
import { AuthProvider } from "@/context/AuthContext";
import LoginPage from "./app/page";
import HomePage from "./app/home/page";
import DashboardPage from "./app/dashboard/page";
import UploadPage from "./app/upload/page";
import GstPage from "./app/gst/page";
import ClientsPage from "./app/clients/page";
import UsersPage from "./app/users/page";
import ExportsPage from "./app/exports/page";
import Exports3bPage from "./app/exports3b/page";
import Verify3bPage from "./app/verify3b/page";
import Itc2bPage from "./app/itc2b/page";
import OutputReconPage from "./app/output-recon/page";
import NotificationsPage from "./app/notifications/page";
import BankingPage from "./app/banking/page";
import InputReconPage from "./app/input-recon/page";
import AuditCompliancePage from "./app/audit-compliance/page";
import AuditDocumentsPage from "./app/audit-documents/page";
import ReconciliationPage from "./app/reconciliation/page";
import SignupPage from "./app/signup/page";
import RequestsPage from "./app/requests/page";
import RequestDetailPage from "./app/requests/[id]/page";
import ReviewPage from "./app/invoices/[id]/review/page";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/requests" element={<RequestsPage />} />
          <Route path="/requests/:id" element={<RequestDetailPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/gst" element={<GstPage />} />
          <Route path="/clients" element={<ClientsPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/exports" element={<ExportsPage />} />
          <Route path="/exports-3b" element={<Exports3bPage />} />
          <Route path="/verify-3b" element={<Verify3bPage />} />
          <Route path="/itc-2b" element={<Itc2bPage />} />
          <Route path="/output-recon" element={<OutputReconPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/banking" element={<BankingPage />} />
          <Route path="/input-recon" element={<InputReconPage />} />
          <Route path="/audit-compliance" element={<AuditCompliancePage />} />
          <Route path="/audit-documents" element={<AuditDocumentsPage />} />
          <Route path="/reconciliation" element={<ReconciliationPage />} />
          <Route path="/invoices/:id/review" element={<ReviewPage />} />
          <Route path="*" element={<HomePage />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);

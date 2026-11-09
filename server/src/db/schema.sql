-- GST Invoice Automator schema (Supabase / PostgreSQL). Idempotent.

create table if not exists firms (
  id uuid primary key default gen_random_uuid(),
  name varchar(255) not null,
  gstin varchar(15),
  address text,
  phone varchar(20),
  email varchar(255),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firms(id) on delete cascade,
  name varchar(255) not null,
  trade_name varchar(255),
  gstin varchar(15),
  email varchar(255),
  phone varchar(20),
  state varchar(100),
  state_code varchar(2),
  address text,
  created_at timestamptz not null default now()
);
create index if not exists clients_firm_idx on clients(firm_id);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email varchar(255) not null unique,
  password_hash varchar(255) not null,
  full_name varchar(255) not null,
  role varchar(20) not null check (role in ('admin','staff','client')),
  firm_id uuid not null references firms(id) on delete cascade,
  client_id uuid references clients(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists users_firm_idx on users(firm_id);

create table if not exists invoice_files (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firms(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  storage_path varchar(500) not null,
  original_filename varchar(255) not null,
  file_size integer not null default 0,
  mime_type varchar(100) not null,
  file_hash varchar(64) not null,
  blur_score double precision,
  is_blurry boolean not null default false,
  is_dark boolean not null default false,
  status varchar(20) not null default 'uploaded',
  error_message text,
  created_at timestamptz not null default now()
);
create index if not exists invoice_files_firm_client_idx on invoice_files(firm_id, client_id);
create index if not exists invoice_files_hash_idx on invoice_files(file_hash);

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firms(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  source_file_id uuid references invoice_files(id) on delete set null,
  invoice_type varchar(20) not null default 'sales',
  supplier_name varchar(255),
  supplier_gstin varchar(15),
  supplier_state varchar(100),
  supplier_address text,
  buyer_name varchar(255),
  buyer_gstin varchar(15),
  buyer_state varchar(100),
  buyer_address text,
  invoice_number varchar(100),
  invoice_date varchar(20),
  place_of_supply varchar(50),
  reverse_charge boolean not null default false,
  total_taxable_value double precision not null default 0,
  cgst_total double precision not null default 0,
  sgst_total double precision not null default 0,
  igst_total double precision not null default 0,
  cess_total double precision not null default 0,
  total_tax double precision not null default 0,
  invoice_total double precision not null default 0,
  overall_confidence double precision not null default 1,
  field_confidences jsonb not null default '{}'::jsonb,
  review_status varchar(20) not null default 'uploaded',
  tax_period varchar(20),
  flags jsonb not null default '[]'::jsonb,
  qr_data jsonb,
  raw_extraction jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists invoices_firm_client_idx on invoices(firm_id, client_id);
create index if not exists invoices_status_idx on invoices(review_status);
create index if not exists invoices_period_idx on invoices(tax_period);

create table if not exists line_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  item_index integer not null default 0,
  description text,
  hsn_sac varchar(20),
  quantity double precision not null default 1,
  unit varchar(50) not null default 'NOS',
  uqc varchar(50) not null default 'NOS-NUMBERS',
  rate double precision not null default 0,
  taxable_value double precision not null default 0,
  total_value double precision not null default 0,
  cgst_rate double precision not null default 0,
  cgst_amount double precision not null default 0,
  sgst_rate double precision not null default 0,
  sgst_amount double precision not null default 0,
  igst_rate double precision not null default 0,
  igst_amount double precision not null default 0,
  cess double precision not null default 0,
  confidence double precision not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists line_items_invoice_idx on line_items(invoice_id);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  user_name varchar(255),
  field_name varchar(100) not null,
  old_value text,
  new_value text,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_invoice_idx on audit_logs(invoice_id);

create table if not exists exports (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firms(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  tax_period varchar(20) not null,
  export_type varchar(20) not null default 'gstr1',
  storage_path varchar(500) not null,
  file_name varchar(255) not null,
  invoice_count integer not null default 0,
  generated_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists exports_firm_idx on exports(firm_id);

alter table invoices add column if not exists client_confirmation varchar(20) not null default 'not_required';
alter table invoices add column if not exists client_confirmed_at timestamptz;
alter table invoices add column if not exists client_confirmed_by uuid references users(id) on delete set null;
alter table invoices add column if not exists client_note text;

-- The API server connects with a privileged role and enforces tenancy itself.
-- RLS with no policies blocks Supabase's public anon/authenticated REST access.
alter table firms enable row level security;
alter table clients enable row level security;
alter table users enable row level security;
alter table invoice_files enable row level security;
alter table invoices enable row level security;
alter table line_items enable row level security;
alter table audit_logs enable row level security;
alter table exports enable row level security;

alter table invoices add column if not exists client_approved_at timestamptz;
alter table invoices add column if not exists client_approved_by uuid;

-- change alert: set when one side edits a sent invoice, cleared when the other side marks it reviewed
alter table invoices add column if not exists alert_for varchar(10);
alter table invoices add column if not exists alert_text text;
alter table invoices add column if not exists alert_at timestamptz;

alter table invoice_files add column if not exists doc_category varchar(20);
alter table invoice_files add column if not exists tax_period varchar(7);
alter table invoice_files add column if not exists progress smallint not null default 0;

-- in-app notifications for both sides: staff see what clients did, clients see what the CA firm did
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firms(id) on delete cascade,
  audience varchar(6) not null,
  client_id uuid not null references clients(id) on delete cascade,
  kind varchar(32) not null,
  title text not null,
  body text,
  link text,
  actor_name text,
  actor_role varchar(10),
  created_at timestamptz not null default now()
);
create index if not exists notifications_aud_idx on notifications(firm_id, audience, client_id, created_at desc);
create table if not exists notification_reads (
  notification_id uuid not null references notifications(id) on delete cascade,
  user_id uuid not null,
  read_at timestamptz not null default now(),
  primary key (notification_id, user_id)
);
alter table notifications enable row level security;
alter table notification_reads enable row level security;

-- a corrected document re-uploaded after CA feedback replaces the earlier one
alter table invoice_files add column if not exists replaces_invoice_id uuid;
alter table invoices add column if not exists replaced_at timestamptz;

-- GSTR-3B verification: the CA firm checks the client's purchase-side documents against the purchase ledger and sends feedback
create table if not exists gstr3b_reviews (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firms(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  tax_period varchar(7) not null,
  status varchar(16) not null default 'pending',
  verified_at timestamptz,
  verified_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, tax_period)
);
create table if not exists gstr3b_notes (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references gstr3b_reviews(id) on delete cascade,
  invoice_id uuid,
  doc_ref text,
  field_label text,
  ledger_value text,
  document_value text,
  message text not null,
  severity varchar(8) not null default 'error',
  resolved boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now()
);
create table if not exists gstr3b_dismissals (
  review_id uuid not null references gstr3b_reviews(id) on delete cascade,
  finding_key text not null,
  reason text,
  dismissed_by uuid,
  created_at timestamptz not null default now(),
  primary key (review_id, finding_key)
);
create table if not exists gstr3b_feedback (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references gstr3b_reviews(id) on delete cascade,
  sent_by uuid,
  sent_by_name text,
  message text not null,
  items jsonb not null default '[]'::jsonb,
  status varchar(12) not null default 'sent',
  created_at timestamptz not null default now(),
  resubmitted_at timestamptz
);
alter table gstr3b_dismissals add column if not exists hidden boolean not null default false;
alter table gstr3b_reviews add column if not exists last_run_at timestamptz;
alter table gstr3b_reviews add column if not exists last_run_sig text;
alter table gstr3b_reviews add column if not exists last_run_by uuid;
alter table gstr3b_reviews enable row level security;
alter table gstr3b_notes enable row level security;
alter table gstr3b_dismissals enable row level security;
alter table gstr3b_feedback enable row level security;

-- which return a document was uploaded for: GSTR-1 (sales side) or GSTR-3B (purchase side)
alter table invoice_files add column if not exists return_type varchar(8);
alter table invoices add column if not exists return_type varchar(8);
update invoice_files set return_type = case when doc_category = 'purchase' then 'gstr3b' else 'gstr1' end where return_type is null;
update invoices set return_type = case when invoice_type = 'purchase' then 'gstr3b' else 'gstr1' end where return_type is null;
alter table invoice_files alter column return_type set default 'gstr1';
alter table invoices alter column return_type set default 'gstr1';
alter table invoice_files add column if not exists progress_label varchar(60);

create table if not exists recon_files (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firms(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  kind varchar(20) not null,
  tax_period varchar(7),
  original_filename varchar(255) not null,
  row_count integer not null default 0,
  data jsonb not null default '{}'::jsonb,
  uploaded_by uuid,
  uploaded_by_role varchar(20),
  created_at timestamptz not null default now()
);
create index if not exists recon_files_client_idx on recon_files (client_id, kind, tax_period);

-- GSTR-2B reconciliation: the three files the CA staff upload for a client and month
alter table clients add column if not exists business_nature varchar(30);
alter table clients add column if not exists business_detail text;
create table if not exists itc_recons (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firms(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  tax_period varchar(7) not null,
  books jsonb,
  books_name varchar(255),
  books_at timestamptz,
  gstr2b jsonb,
  gstr2b_name varchar(255),
  gstr2b_at timestamptz,
  gstr1 jsonb,
  gstr1_name varchar(255),
  gstr1_path text,
  gstr1_status varchar(10) not null default 'none',
  gstr1_error text,
  gstr1_at timestamptz,
  opening_itc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (client_id, tax_period)
);
alter table itc_recons enable row level security;

-- Output GST reconciliation (GSTR-1, GSTR-3B and books for a financial year, for GSTR-9 and 9C workings)
create table if not exists output_files (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firms(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  fy varchar(7) not null,
  kind varchar(8) not null,
  original_filename varchar(255) not null,
  period varchar(7),
  row_count integer not null default 0,
  data jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists output_files_idx on output_files (client_id, fy, kind);
create table if not exists output_settings (
  client_id uuid not null references clients(id) on delete cascade,
  fy varchar(7) not null,
  party_types text not null default '',
  updated_at timestamptz not null default now(),
  primary key (client_id, fy)
);
alter table output_files enable row level security;
alter table output_settings enable row level security;

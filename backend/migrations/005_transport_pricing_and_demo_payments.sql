-- Additive transport, configurable pricing, and explicitly simulated payment support.
-- Apply after 001-004 only after reviewing the target database. This file is not
-- automatically applied by the application.

CREATE TABLE company_shipping_rate_rules (
  rate_rule_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  origin_hub_id VARCHAR(20) NOT NULL,
  destination_hub_id VARCHAR(20) NOT NULL,
  mode VARCHAR(30) NOT NULL,
  base_charge DECIMAL(12,2) NOT NULL,
  included_weight_kg DECIMAL(12,3) NOT NULL DEFAULT 1.000,
  per_kg_charge DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  service_charge DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  minimum_charge DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  tax_rate_percent DECIMAL(7,4) NOT NULL DEFAULT 0.0000,
  volumetric_divisor DECIMAL(12,2) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (rate_rule_id),
  UNIQUE KEY uq_company_shipping_rate_route_mode (company_id, origin_hub_id, destination_hub_id, mode),
  KEY ix_company_shipping_rate_active (company_id, active),
  CONSTRAINT fk_shipping_rate_company FOREIGN KEY (company_id) REFERENCES companies(company_id),
  CONSTRAINT fk_shipping_rate_origin_hub FOREIGN KEY (origin_hub_id) REFERENCES hubs(hub_id),
  CONSTRAINT fk_shipping_rate_destination_hub FOREIGN KEY (destination_hub_id) REFERENCES hubs(hub_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE company_payment_settings (
  company_id INT NOT NULL,
  sender_pays_enabled TINYINT(1) NOT NULL DEFAULT 1,
  receiver_pays_enabled TINYINT(1) NOT NULL DEFAULT 1,
  demo_upi_enabled TINYINT(1) NOT NULL DEFAULT 0,
  pay_at_pickup_enabled TINYINT(1) NOT NULL DEFAULT 0,
  pay_at_delivery_enabled TINYINT(1) NOT NULL DEFAULT 0,
  cod_enabled TINYINT(1) NOT NULL DEFAULT 0,
  updated_by_employee_id VARCHAR(30) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id),
  CONSTRAINT fk_company_payment_settings_company FOREIGN KEY (company_id) REFERENCES companies(company_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE customer_booking_requests
  ADD COLUMN length_cm DECIMAL(10,2) NULL,
  ADD COLUMN width_cm DECIMAL(10,2) NULL,
  ADD COLUMN height_cm DECIMAL(10,2) NULL,
  ADD COLUMN quoted_base_charge DECIMAL(12,2) NULL,
  ADD COLUMN quoted_weight_charge DECIMAL(12,2) NULL,
  ADD COLUMN quoted_service_charge DECIMAL(12,2) NULL,
  ADD COLUMN quoted_tax_amount DECIMAL(12,2) NULL,
  ADD COLUMN quoted_total DECIMAL(12,2) NULL,
  ADD COLUMN quoted_minimum_adjustment DECIMAL(12,2) NULL,
  ADD COLUMN quoted_chargeable_weight_kg DECIMAL(12,3) NULL,
  ADD COLUMN quote_currency CHAR(3) NOT NULL DEFAULT 'INR',
  ADD COLUMN quote_rule_id BIGINT UNSIGNED NULL,
  ADD COLUMN charge_payer ENUM('SENDER','RECEIVER') NULL,
  ADD COLUMN collection_method ENUM('DEMO_UPI','PAY_AT_PICKUP','PAY_AT_DELIVERY') NULL,
  ADD COLUMN payment_status ENUM('NOT_REQUIRED','DEMO_PENDING','DEMO_PROCESSING','DEMO_PAID','DEMO_FAILED','COLLECTION_DUE','COLLECTED','REFUNDED') NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN cod_amount DECIMAL(12,2) NULL,
  ADD KEY ix_customer_booking_payment (status, payment_status);

ALTER TABLE shipments
  ADD COLUMN cod_amount DECIMAL(12,2) NULL;

CREATE TABLE shipment_payments (
  payment_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  customer_account_id BIGINT UNSIGNED NOT NULL,
  booking_request_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  payment_method ENUM('DEMO_UPI','PAY_AT_PICKUP','PAY_AT_DELIVERY') NOT NULL,
  payment_mode ENUM('DEMO','OFFLINE') NOT NULL,
  payment_status ENUM('DEMO_PENDING','DEMO_PROCESSING','DEMO_PAID','DEMO_FAILED','DEMO_CANCELLED','COLLECTION_DUE','COLLECTED','REFUNDED') NOT NULL,
  transaction_reference VARCHAR(80) NULL,
  completed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (payment_id),
  UNIQUE KEY uq_shipment_payment_booking (company_id, booking_request_id),
  UNIQUE KEY uq_shipment_payment_reference (company_id, transaction_reference),
  KEY ix_shipment_payment_customer (company_id, customer_account_id, created_at),
  CONSTRAINT fk_shipment_payment_company FOREIGN KEY (company_id) REFERENCES companies(company_id),
  CONSTRAINT fk_shipment_payment_account FOREIGN KEY (customer_account_id) REFERENCES customer_accounts(customer_account_id),
  CONSTRAINT fk_shipment_payment_booking FOREIGN KEY (booking_request_id) REFERENCES customer_booking_requests(booking_request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE shipment_collections (
  collection_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  consignment_no VARCHAR(50) NOT NULL,
  task_type ENUM('PICKUP','DELIVERY') NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  collection_method ENUM('PAY_AT_PICKUP','PAY_AT_DELIVERY','COD') NOT NULL,
  collection_channel ENUM('DEMO_CASH','DEMO_UPI') NOT NULL,
  collection_status ENUM('COLLECTED','VOIDED') NOT NULL DEFAULT 'COLLECTED',
  recorded_by_employee_id VARCHAR(30) NOT NULL,
  recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  idempotency_key CHAR(36) NOT NULL,
  PRIMARY KEY (collection_id),
  UNIQUE KEY uq_shipment_collection_idempotency (company_id, idempotency_key),
  KEY ix_shipment_collection_company_time (company_id, recorded_at),
  KEY ix_shipment_collection_shipment (company_id, consignment_no),
  CONSTRAINT fk_shipment_collection_company FOREIGN KEY (company_id) REFERENCES companies(company_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE transport_trips (
  trip_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  origin_hub_id VARCHAR(20) NOT NULL,
  destination_hub_id VARCHAR(20) NOT NULL,
  vehicle_number VARCHAR(30) NOT NULL,
  driver_name VARCHAR(255) NOT NULL,
  driver_phone VARCHAR(40) NULL,
  status ENUM('PLANNED','LOADING','READY_TO_DEPART','IN_TRANSIT','ARRIVED','CLOSED','CANCELLED') NOT NULL DEFAULT 'PLANNED',
  scheduled_departure DATETIME NULL,
  actual_departure DATETIME NULL,
  actual_arrival DATETIME NULL,
  created_by_employee_id VARCHAR(30) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (trip_id),
  KEY ix_transport_trip_origin_status (company_id, origin_hub_id, status, created_at),
  KEY ix_transport_trip_destination_status (company_id, destination_hub_id, status, created_at),
  CONSTRAINT fk_transport_trip_company FOREIGN KEY (company_id) REFERENCES companies(company_id),
  CONSTRAINT fk_transport_trip_origin FOREIGN KEY (origin_hub_id) REFERENCES hubs(hub_id),
  CONSTRAINT fk_transport_trip_destination FOREIGN KEY (destination_hub_id) REFERENCES hubs(hub_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE transport_trip_shipments (
  trip_id BIGINT UNSIGNED NOT NULL,
  company_id INT NOT NULL,
  consignment_no VARCHAR(50) NOT NULL,
  loading_status ENUM('PENDING','LOADED','RECEIVED','MISSING','DAMAGED') NOT NULL DEFAULT 'PENDING',
  loaded_at DATETIME NULL,
  received_at DATETIME NULL,
  receiving_condition ENUM('GOOD','DAMAGED','MISSING') NULL,
  exception_reason TEXT NULL,
  PRIMARY KEY (trip_id, consignment_no),
  KEY ix_transport_manifest_shipment (company_id, consignment_no, loading_status),
  CONSTRAINT fk_transport_manifest_trip FOREIGN KEY (trip_id) REFERENCES transport_trips(trip_id),
  CONSTRAINT fk_transport_manifest_company FOREIGN KEY (company_id) REFERENCES companies(company_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE transport_trip_events (
  trip_event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  trip_id BIGINT UNSIGNED NOT NULL,
  company_id INT NOT NULL,
  event_type ENUM('CREATED','SHIPMENT_ADDED','SHIPMENT_LOADED','DEPARTED','ARRIVED','SHIPMENT_RECEIVED','SHIPMENT_MISSING','SHIPMENT_DAMAGED','CLOSED','CANCELLED') NOT NULL,
  consignment_no VARCHAR(50) NULL,
  hub_id VARCHAR(20) NULL,
  recorded_by_employee_id VARCHAR(30) NOT NULL,
  occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT NULL,
  PRIMARY KEY (trip_event_id),
  KEY ix_transport_trip_events_history (company_id, trip_id, occurred_at),
  CONSTRAINT fk_transport_trip_event_trip FOREIGN KEY (trip_id) REFERENCES transport_trips(trip_id),
  CONSTRAINT fk_transport_trip_event_company FOREIGN KEY (company_id) REFERENCES companies(company_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

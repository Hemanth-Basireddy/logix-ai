-- Customer identity and booking idempotency. Apply only after review, never to
-- the production DTDC database without explicit approval.
CREATE TABLE customer_accounts (
  customer_account_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  customer_id VARCHAR(20) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (customer_account_id),
  UNIQUE KEY uq_customer_accounts_company_email (company_id, email),
  UNIQUE KEY uq_customer_accounts_company_customer (company_id, customer_id),
  CONSTRAINT fk_customer_accounts_company FOREIGN KEY (company_id) REFERENCES companies(company_id),
  CONSTRAINT fk_customer_accounts_customer FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE customer_booking_requests (
  customer_account_id BIGINT UNSIGNED NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  consignment_no VARCHAR(50) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (customer_account_id, idempotency_key),
  UNIQUE KEY uq_customer_booking_consignment (consignment_no),
  CONSTRAINT fk_customer_booking_account FOREIGN KEY (customer_account_id) REFERENCES customer_accounts(customer_account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

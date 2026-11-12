-- Extend the idempotency table into a customer booking-request queue.
-- Existing rows are preserved. Requests with an existing consignment are
-- marked approved; incomplete legacy rows require manual review.
ALTER TABLE customer_booking_requests
  ADD COLUMN booking_request_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  ADD COLUMN status ENUM('PENDING_APPROVAL','APPROVED','REJECTED','LEGACY_REVIEW') NOT NULL DEFAULT 'LEGACY_REVIEW',
  ADD COLUMN origin_hub_id VARCHAR(20) NULL,
  ADD COLUMN destination_hub_id VARCHAR(20) NULL,
  ADD COLUMN mode VARCHAR(30) NULL,
  ADD COLUMN pieces INT UNSIGNED NULL,
  ADD COLUMN weight_kg DECIMAL(12,3) NULL,
  ADD COLUMN sender_name VARCHAR(255) NULL,
  ADD COLUMN sender_phone VARCHAR(40) NULL,
  ADD COLUMN sender_address TEXT NULL,
  ADD COLUMN sender_city VARCHAR(100) NULL,
  ADD COLUMN sender_state VARCHAR(100) NULL,
  ADD COLUMN sender_pincode VARCHAR(20) NULL,
  ADD COLUMN recipient_name VARCHAR(255) NULL,
  ADD COLUMN recipient_phone VARCHAR(40) NULL,
  ADD COLUMN recipient_address TEXT NULL,
  ADD COLUMN recipient_city VARCHAR(100) NULL,
  ADD COLUMN recipient_state VARCHAR(100) NULL,
  ADD COLUMN recipient_pincode VARCHAR(20) NULL,
  ADD COLUMN rejection_reason TEXT NULL,
  ADD COLUMN reviewed_by_employee_id VARCHAR(30) NULL,
  ADD COLUMN reviewed_at DATETIME NULL,
  ADD KEY ix_customer_booking_status (status, created_at);

UPDATE customer_booking_requests
   SET status = 'APPROVED'
 WHERE consignment_no IS NOT NULL;

-- Additive workflow state for assignments already stored on shipments as
-- origin_logistics_executive_{1,2}_id and destination_logistics_executive_{1,2}_id.
-- No historical rows or shipment assignment columns are backfilled or changed.
CREATE TABLE logistics_task_progress (
  task_progress_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  consignment_no VARCHAR(50) NOT NULL,
  task_type ENUM('PICKUP', 'DELIVERY') NOT NULL,
  status ENUM('PENDING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
  failure_reason TEXT NULL,
  assigned_by_employee_id VARCHAR(30) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (task_progress_id),
  UNIQUE KEY uq_logistics_task_progress_shipment_type (company_id, consignment_no, task_type),
  KEY ix_logistics_task_progress_company_status (company_id, status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

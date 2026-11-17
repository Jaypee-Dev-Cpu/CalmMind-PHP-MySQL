-- ============================================================================
-- CalmMind Full-Stack MySQL Database Schema
-- Import this file via phpMyAdmin or MySQL CLI (XAMPP / WAMP / Laragon)
-- ============================================================================

CREATE DATABASE IF NOT EXISTS calmmind_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE calmmind_db;

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_study_data (
  user_id INT UNSIGNED PRIMARY KEY,
  state_json LONGTEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_study_data_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add missing customer columns to customer_intents table
ALTER TABLE customer_intents 
ADD COLUMN IF NOT EXISTS customer_firstname VARCHAR(255),
ADD COLUMN IF NOT EXISTS customer_lastname VARCHAR(255),
ADD COLUMN IF NOT EXISTS customer_email VARCHAR(255),
ADD COLUMN IF NOT EXISTS customer_country VARCHAR(255);
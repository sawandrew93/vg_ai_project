-- Create customer attachments table
CREATE TABLE IF NOT EXISTS customer_attachments (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    original_filename VARCHAR(255) NOT NULL,
    file_size INTEGER NOT NULL,
    file_type VARCHAR(100) NOT NULL,
    file_url TEXT NOT NULL,
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_customer_attachments_session_id ON customer_attachments(session_id);
CREATE INDEX IF NOT EXISTS idx_customer_attachments_uploaded_at ON customer_attachments(uploaded_at);
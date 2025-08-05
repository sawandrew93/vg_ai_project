# AI Chatbot Knowledge Base Setup Guide

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Database Setup
1. Go to your Supabase dashboard
2. Run the SQL script from `setup-database.sql` in the SQL editor
3. This will create the documents table and necessary functions

### 3. Initialize Knowledge Base
```bash
npm run setup-kb
```

This will:
- Test your database connection
- Test embedding generation
- Add sample documents
- Test search functionality

### 4. Start the Server
```bash
npm start
```

## 📚 Adding Knowledge Base Content

### Method 1: PDF Upload (Recommended)
```bash
# Upload single PDF
npm run ingest-pdf "path/to/your/document.pdf" "Document Title"

# Upload all PDFs from a directory
npm run ingest-pdf --directory "path/to/your/docs/"
```

### Method 2: Google Drive Integration
1. Create a Google Cloud Project
2. Enable Google Drive API and Google Docs API
3. Create a service account and download credentials JSON
4. Place credentials as `google-credentials.json` in project root
5. Share your Google Drive folder with the service account email

```bash
# Ingest from Google Drive folder
npm run ingest-gdrive --folder "your-google-drive-folder-id"

# List available files
npm run ingest-gdrive --list
```

### Method 3: Web Interface
Visit `http://localhost:3000/knowledge-base` to:
- Upload PDF files via drag & drop
- Manage existing documents
- Test search functionality
- View statistics

## 🔧 Configuration

### Environment Variables (.env)
```env
# Gemini AI Configuration
GEMINI_API_KEY=your_gemini_api_key

# Supabase Configuration
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key

# Google Drive (Optional)
GOOGLE_CREDENTIALS_PATH=./google-credentials.json

# Server Configuration
PORT=3000
JWT_SECRET=your_jwt_secret
```

### Similarity Threshold
In `server.js`, adjust `SIMILARITY_THRESHOLD`:
- `0.3` - Strict matching (recommended)
- `0.2` - Moderate matching
- `0.1` - Loose matching

## 🧪 Testing Your Setup

### 1. Test Knowledge Base Search
```bash
curl "http://localhost:3000/test-kb?q=pricing"
```

### 2. Test Chatbot
Visit `http://localhost:3000` and ask questions like:
- "How much does your service cost?"
- "Do you have a free trial?"
- "Can I cancel my subscription?"

### 3. Monitor Performance
- Visit `http://localhost:3000/test-kb` for detailed search testing
- Check server logs for embedding generation and search results

## 📊 Knowledge Base Management

### CLI Commands
```bash
# Setup and test
npm run setup-kb              # Full setup
node knowledge-base/setup.js test    # Test connections only
node knowledge-base/setup.js stats   # Show statistics

# PDF ingestion
npm run ingest-pdf file.pdf "Title"
npm run ingest-pdf --directory ./docs/

# Google Drive ingestion
npm run ingest-gdrive --folder folder-id
npm run ingest-gdrive --list
```

### Web Interface
- **Upload**: `http://localhost:3000/knowledge-base`
- **Agent Dashboard**: `http://localhost:3000/agent`
- **Main Chat**: `http://localhost:3000`

## 🔍 How It Works

### 1. Document Processing
- PDFs are parsed and split into chunks (~1000 characters)
- Each chunk overlaps by 200 characters for context
- Text is cleaned and normalized

### 2. Embedding Generation
- Uses Google Gemini's `text-embedding-004` model
- Generates 768-dimensional vectors
- Batch processing with rate limiting

### 3. Vector Search
- Cosine similarity search in Supabase
- Configurable similarity threshold
- Returns top-k most relevant chunks

### 4. AI Response Generation
- Uses Google Gemini Flash 2.5 (`gemini-2.0-flash-exp`)
- Combines search results with conversational context
- Intelligent handoff detection for human support

## 🛠️ Troubleshooting

### Common Issues

1. **"No relevant documents found"**
   - Lower the similarity threshold
   - Add more diverse content
   - Check if documents were properly ingested

2. **"Database connection failed"**
   - Verify Supabase URL and key
   - Run the setup SQL script
   - Check network connectivity

3. **"Embedding generation failed"**
   - Verify Gemini API key
   - Check API quotas and limits
   - Ensure text is not empty

4. **PDF processing errors**
   - Ensure PDFs are text-based (not scanned images)
   - Check file size limits (10MB max)
   - Verify file permissions

### Debug Commands
```bash
# Test database connection
node debug-db.js

# Test specific document search
node -e "
const setup = require('./knowledge-base/setup');
const s = new setup();
s.testSearch().then(() => process.exit());
"

# Check document count
node -e "
const db = require('./knowledge-base/database');
const d = new db();
d.getDocumentStats().then(stats => {
  console.log(stats);
  process.exit();
});
"
```

## 📈 Performance Tips

1. **Optimize Chunk Size**: Adjust `chunkSize` in `document-processor.js`
2. **Batch Processing**: Use directory upload for multiple files
3. **Regular Cleanup**: Remove outdated documents
4. **Monitor Similarity**: Use test interface to tune thresholds
5. **Cache Results**: Consider implementing response caching

## 🔒 Security Notes

- Keep your API keys secure
- Use environment variables for sensitive data
- Regularly rotate service account credentials
- Monitor API usage and costs
- Implement rate limiting for production use

## 📞 Support

If you encounter issues:
1. Check the server logs for detailed error messages
2. Test individual components using the CLI tools
3. Verify your environment configuration
4. Use the web interface for easier debugging
// knowledge-base/ingest-gdrive.js
require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs').promises;
const path = require('path');
const DocumentProcessor = require('./document-processor');
const EmbeddingService = require('./embeddings');
const KnowledgeBaseDB = require('./database');

class GoogleDriveIngestionService {
  constructor() {
    this.processor = new DocumentProcessor();
    this.embeddingService = new EmbeddingService();
    this.db = new KnowledgeBaseDB();
    this.drive = null;
    this.docs = null;
  }

  async authenticate() {
    try {
      // Check if credentials file exists
      const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH || './google-credentials.json';
      
      try {
        await fs.access(credentialsPath);
      } catch (error) {
        throw new Error(`Google credentials file not found at: ${credentialsPath}. Please download your service account key from Google Cloud Console.`);
      }

      const credentials = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
      
      const auth = new google.auth.GoogleAuth({
        credentials: credentials,
        scopes: [
          'https://www.googleapis.com/auth/drive.readonly',
          'https://www.googleapis.com/auth/documents.readonly'
        ]
      });

      const authClient = await auth.getClient();
      
      this.drive = google.drive({ version: 'v3', auth: authClient });
      this.docs = google.docs({ version: 'v1', auth: authClient });
      
      console.log('✅ Google Drive authentication successful');
      return true;
    } catch (error) {
      console.error('❌ Google Drive authentication failed:', error.message);
      throw error;
    }
  }

  async listFiles(folderId = null, mimeTypes = ['application/pdf', 'application/vnd.google-apps.document']) {
    try {
      if (!this.drive) {
        await this.authenticate();
      }

      let query = `trashed=false`;
      
      if (folderId) {
        query += ` and '${folderId}' in parents`;
      }
      
      if (mimeTypes && mimeTypes.length > 0) {
        const mimeQuery = mimeTypes.map(type => `mimeType='${type}'`).join(' or ');
        query += ` and (${mimeQuery})`;
      }

      const response = await this.drive.files.list({
        q: query,
        fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink)',
        pageSize: 100
      });

      console.log(`📁 Found ${response.data.files.length} files`);
      return response.data.files;
    } catch (error) {
      console.error('❌ Error listing files:', error);
      throw error;
    }
  }

  async downloadFile(fileId, fileName) {
    try {
      const tempDir = './temp';
      
      // Create temp directory if it doesn't exist
      try {
        await fs.mkdir(tempDir, { recursive: true });
      } catch (error) {
        // Directory might already exist
      }

      const filePath = path.join(tempDir, fileName);
      
      const response = await this.drive.files.get({
        fileId: fileId,
        alt: 'media'
      });

      await fs.writeFile(filePath, response.data);
      console.log(`📥 Downloaded: ${fileName}`);
      
      return filePath;
    } catch (error) {
      console.error(`❌ Error downloading file ${fileName}:`, error);
      throw error;
    }
  }

  async exportGoogleDoc(fileId, fileName) {
    try {
      const tempDir = './temp';
      
      // Create temp directory if it doesn't exist
      try {
        await fs.mkdir(tempDir, { recursive: true });
      } catch (error) {
        // Directory might already exist
      }

      // Get document content using Google Docs API
      const doc = await this.docs.documents.get({
        documentId: fileId
      });

      // Extract text content from the document
      let text = '';
      if (doc.data.body && doc.data.body.content) {
        for (const element of doc.data.body.content) {
          if (element.paragraph) {
            for (const textElement of element.paragraph.elements || []) {
              if (textElement.textRun) {
                text += textElement.textRun.content;
              }
            }
          }
        }
      }

      const filePath = path.join(tempDir, fileName.replace(/\.[^/.]+$/, '') + '.txt');
      await fs.writeFile(filePath, text, 'utf8');
      
      console.log(`📥 Exported Google Doc: ${fileName}`);
      return filePath;
    } catch (error) {
      console.error(`❌ Error exporting Google Doc ${fileName}:`, error);
      throw error;
    }
  }

  async ingestFile(fileId, fileName, mimeType) {
    try {
      console.log(`🔄 Processing: ${fileName} (${mimeType})`);
      
      let filePath;
      
      if (mimeType === 'application/vnd.google-apps.document') {
        // Export Google Doc as text
        filePath = await this.exportGoogleDoc(fileId, fileName);
      } else if (mimeType === 'application/pdf') {
        // Download PDF file
        filePath = await this.downloadFile(fileId, fileName);
      } else {
        throw new Error(`Unsupported file type: ${mimeType}`);
      }

      // Process the document
      const result = await this.processor.processDocument(filePath, fileName);
      
      console.log(`📝 Processing ${result.chunks.length} chunks...`);
      
      // Generate embeddings for all chunks
      const embeddings = await this.embeddingService.generateBatchEmbeddings(
        result.chunks.map(chunk => chunk.content)
      );

      // Prepare documents for insertion
      const documents = [];
      for (let i = 0; i < result.chunks.length; i++) {
        const chunk = result.chunks[i];
        const embeddingResult = embeddings[i];
        
        if (embeddingResult.success) {
          documents.push({
            title: chunk.title || fileName,
            content: chunk.content,
            metadata: {
              ...result.metadata,
              chunk_index: i,
              total_chunks: result.chunks.length,
              chunk_length: chunk.length,
              google_drive_file_id: fileId,
              original_mime_type: mimeType
            },
            embedding: embeddingResult.embedding,
            source_type: 'google_drive',
            source_url: `https://drive.google.com/file/d/${fileId}/view`
          });
        } else {
          console.warn(`⚠️ Skipping chunk ${i} due to embedding error: ${embeddingResult.error}`);
        }
      }

      // Insert documents into database
      if (documents.length > 0) {
        const insertedDocs = await this.db.insertBulkDocuments(documents);
        
        console.log(`✅ Successfully ingested: ${fileName}`);
        console.log(`   - Chunks created: ${result.chunks.length}`);
        console.log(`   - Chunks inserted: ${insertedDocs.length}`);
        
        // Clean up temporary file
        try {
          await fs.unlink(filePath);
        } catch (error) {
          console.warn(`⚠️ Could not delete temp file: ${filePath}`);
        }
        
        return {
          success: true,
          filename: fileName,
          chunksCreated: result.chunks.length,
          chunksInserted: insertedDocs.length,
          insertedIds: insertedDocs.map(doc => doc.id)
        };
      } else {
        throw new Error('No valid chunks could be processed');
      }
      
    } catch (error) {
      console.error(`❌ Failed to ingest ${fileName}:`, error);
      throw error;
    }
  }

  async ingestFromFolder(folderId) {
    try {
      console.log(`📁 Ingesting files from Google Drive folder: ${folderId}`);
      
      const files = await this.listFiles(folderId);
      
      if (files.length === 0) {
        console.log('⚠️ No supported files found in folder');
        return { success: true, processedFiles: [] };
      }

      const results = [];
      
      for (const file of files) {
        try {
          const result = await this.ingestFile(file.id, file.name, file.mimeType);
          results.push({ file: file.name, ...result });
          
          // Small delay between files to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
          console.error(`❌ Failed to process ${file.name}:`, error.message);
          results.push({ 
            file: file.name, 
            success: false, 
            error: error.message 
          });
        }
      }

      const successful = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);
      
      console.log(`\n🎉 Google Drive ingestion complete!`);
      console.log(`✅ Successfully processed: ${successful.length} files`);
      console.log(`❌ Failed: ${failed.length} files`);
      
      return {
        success: true,
        processedFiles: results,
        totalFiles: files.length,
        successfulFiles: successful.length,
        failedFiles: failed.length
      };
      
    } catch (error) {
      console.error('❌ Google Drive folder ingestion failed:', error);
      throw error;
    }
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('📖 Usage:');
    console.log('  node knowledge-base/ingest-gdrive.js --folder <folder-id>');
    console.log('  node knowledge-base/ingest-gdrive.js --file <file-id> <file-name>');
    console.log('  node knowledge-base/ingest-gdrive.js --list [folder-id]');
    console.log('');
    console.log('Examples:');
    console.log('  node knowledge-base/ingest-gdrive.js --folder 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms');
    console.log('  node knowledge-base/ingest-gdrive.js --file 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms "Document Name"');
    console.log('  node knowledge-base/ingest-gdrive.js --list');
    console.log('');
    console.log('Setup:');
    console.log('  1. Create a service account in Google Cloud Console');
    console.log('  2. Download the credentials JSON file');
    console.log('  3. Set GOOGLE_CREDENTIALS_PATH in .env or place file as ./google-credentials.json');
    process.exit(1);
  }

  const ingestionService = new GoogleDriveIngestionService();

  try {
    if (args[0] === '--folder') {
      if (!args[1]) {
        console.error('❌ Please provide folder ID');
        process.exit(1);
      }
      await ingestionService.ingestFromFolder(args[1]);
    } else if (args[0] === '--file') {
      if (!args[1] || !args[2]) {
        console.error('❌ Please provide file ID and name');
        process.exit(1);
      }
      await ingestionService.ingestFile(args[1], args[2], 'application/pdf'); // Default to PDF
    } else if (args[0] === '--list') {
      await ingestionService.authenticate();
      const files = await ingestionService.listFiles(args[1]);
      console.log('\n📁 Available files:');
      files.forEach(file => {
        console.log(`   - ${file.name} (${file.mimeType}) - ID: ${file.id}`);
      });
    } else {
      console.error('❌ Invalid command. Use --folder, --file, or --list');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Operation failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = GoogleDriveIngestionService;
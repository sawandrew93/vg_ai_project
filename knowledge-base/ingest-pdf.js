// knowledge-base/ingest-pdf.js
require('dotenv').config();
const path = require('path');
const fs = require('fs').promises;
const DocumentProcessor = require('./document-processor');
const EmbeddingService = require('./embeddings');
const KnowledgeBaseDB = require('./database');

class PDFIngestionService {
  constructor() {
    this.processor = new DocumentProcessor();
    this.embeddingService = new EmbeddingService();
    this.db = new KnowledgeBaseDB();
  }

  async ingestPDF(filePath, title = '') {
    try {
      console.log(`🚀 Starting PDF ingestion: ${filePath}`);
      
      // Check if file exists
      try {
        await fs.access(filePath);
      } catch (error) {
        throw new Error(`File not found: ${filePath}`);
      }

      // Process the document
      const result = await this.processor.processDocument(filePath, title, 'pdf');
      
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
            title: chunk.title || title || result.metadata.filename,
            content: chunk.content,
            metadata: {
              ...result.metadata,
              chunk_index: i,
              total_chunks: result.chunks.length,
              chunk_length: chunk.length
            },
            embedding: embeddingResult.embedding,
            source_type: 'pdf',
            source_url: filePath
          });
        } else {
          console.warn(`⚠️ Skipping chunk ${i} due to embedding error: ${embeddingResult.error}`);
        }
      }

      // Insert documents into database
      if (documents.length > 0) {
        const insertedDocs = await this.db.insertBulkDocuments(documents);
        
        console.log(`🎉 Successfully ingested PDF!`);
        console.log(`📊 Stats:`);
        console.log(`   - File: ${result.metadata.filename}`);
        console.log(`   - Pages: ${result.metadata.pages || 'N/A'}`);
        console.log(`   - Chunks created: ${result.chunks.length}`);
        console.log(`   - Chunks inserted: ${insertedDocs.length}`);
        console.log(`   - Total characters: ${result.originalText.length}`);
        
        return {
          success: true,
          filename: result.metadata.filename,
          chunksCreated: result.chunks.length,
          chunksInserted: insertedDocs.length,
          totalCharacters: result.originalText.length,
          insertedIds: insertedDocs.map(doc => doc.id)
        };
      } else {
        throw new Error('No valid chunks could be processed');
      }
      
    } catch (error) {
      console.error('❌ PDF ingestion failed:', error);
      throw error;
    }
  }

  async ingestMultiplePDFs(directoryPath) {
    try {
      console.log(`📁 Scanning directory: ${directoryPath}`);
      
      const files = await fs.readdir(directoryPath);
      const pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'));
      
      if (pdfFiles.length === 0) {
        console.log('⚠️ No PDF files found in directory');
        return { success: true, processedFiles: [] };
      }

      console.log(`📄 Found ${pdfFiles.length} PDF files`);
      
      const results = [];
      
      for (const pdfFile of pdfFiles) {
        const filePath = path.join(directoryPath, pdfFile);
        try {
          console.log(`\n🔄 Processing: ${pdfFile}`);
          const result = await this.ingestPDF(filePath, pdfFile.replace('.pdf', ''));
          results.push({ file: pdfFile, ...result });
          
          // Small delay between files to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
          console.error(`❌ Failed to process ${pdfFile}:`, error.message);
          results.push({ 
            file: pdfFile, 
            success: false, 
            error: error.message 
          });
        }
      }

      const successful = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);
      
      console.log(`\n🎉 Batch processing complete!`);
      console.log(`✅ Successfully processed: ${successful.length} files`);
      console.log(`❌ Failed: ${failed.length} files`);
      
      if (failed.length > 0) {
        console.log(`\n❌ Failed files:`);
        failed.forEach(f => console.log(`   - ${f.file}: ${f.error}`));
      }

      return {
        success: true,
        processedFiles: results,
        totalFiles: pdfFiles.length,
        successfulFiles: successful.length,
        failedFiles: failed.length
      };
      
    } catch (error) {
      console.error('❌ Batch PDF ingestion failed:', error);
      throw error;
    }
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('📖 Usage:');
    console.log('  node knowledge-base/ingest-pdf.js <file-path> [title]');
    console.log('  node knowledge-base/ingest-pdf.js --directory <directory-path>');
    console.log('');
    console.log('Examples:');
    console.log('  node knowledge-base/ingest-pdf.js ./docs/manual.pdf "User Manual"');
    console.log('  node knowledge-base/ingest-pdf.js --directory ./docs/');
    process.exit(1);
  }

  const ingestionService = new PDFIngestionService();

  try {
    if (args[0] === '--directory') {
      if (!args[1]) {
        console.error('❌ Please provide directory path');
        process.exit(1);
      }
      await ingestionService.ingestMultiplePDFs(args[1]);
    } else {
      const filePath = args[0];
      const title = args[1] || '';
      await ingestionService.ingestPDF(filePath, title);
    }
  } catch (error) {
    console.error('❌ Ingestion failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = PDFIngestionService;
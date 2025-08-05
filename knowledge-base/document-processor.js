// knowledge-base/document-processor.js
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const fs = require('fs').promises;

class DocumentProcessor {
  constructor() {
    this.chunkSize = 1000; // Characters per chunk
    this.chunkOverlap = 200; // Overlap between chunks
  }

  async processPDF(filePath) {
    try {
      console.log(`📄 Processing PDF: ${filePath}`);
      
      const dataBuffer = await fs.readFile(filePath);
      const data = await pdf(dataBuffer);
      
      const text = data.text;
      const metadata = {
        pages: data.numpages,
        info: data.info,
        source_type: 'pdf',
        filename: filePath.split('\\').pop()
      };

      console.log(`✅ Extracted ${text.length} characters from ${data.numpages} pages`);
      
      return {
        text: text,
        metadata: metadata
      };
    } catch (error) {
      console.error('❌ Error processing PDF:', error);
      throw error;
    }
  }

  async processTextFile(filePath) {
    try {
      console.log(`📄 Processing text file: ${filePath}`);
      
      const text = await fs.readFile(filePath, 'utf-8');
      const metadata = {
        source_type: 'text',
        filename: filePath.split('\\').pop()
      };

      console.log(`✅ Extracted ${text.length} characters`);
      
      return {
        text: text,
        metadata: metadata
      };
    } catch (error) {
      console.error('❌ Error processing text file:', error);
      throw error;
    }
  }

  async processWordFile(filePath) {
    try {
      console.log(`📄 Processing Word file: ${filePath}`);
      
      const result = await mammoth.extractRawText({ path: filePath });
      const text = result.value;
      const metadata = {
        source_type: 'word',
        filename: filePath.split('\\').pop()
      };

      console.log(`✅ Extracted ${text.length} characters from Word document`);
      
      return {
        text: text,
        metadata: metadata
      };
    } catch (error) {
      console.error('❌ Error processing Word file:', error);
      throw error;
    }
  }

  async processExcelFile(filePath) {
    try {
      console.log(`📄 Processing Excel file: ${filePath}`);
      
      const workbook = xlsx.readFile(filePath);
      let text = '';
      
      workbook.SheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        const sheetText = xlsx.utils.sheet_to_txt(sheet);
        text += `Sheet: ${sheetName}\n${sheetText}\n\n`;
      });
      
      const metadata = {
        source_type: 'excel',
        filename: filePath.split('\\').pop(),
        sheets: workbook.SheetNames.length
      };

      console.log(`✅ Extracted ${text.length} characters from ${workbook.SheetNames.length} sheets`);
      
      return {
        text: text,
        metadata: metadata
      };
    } catch (error) {
      console.error('❌ Error processing Excel file:', error);
      throw error;
    }
  }

  chunkText(text, title = '') {
    if (!text || text.trim().length === 0) {
      return [];
    }

    const chunks = [];
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    
    let currentChunk = '';
    let currentLength = 0;

    for (const sentence of sentences) {
      const sentenceLength = sentence.trim().length;
      
      // If adding this sentence would exceed chunk size, save current chunk
      if (currentLength + sentenceLength > this.chunkSize && currentChunk.length > 0) {
        chunks.push({
          content: currentChunk.trim(),
          title: title,
          length: currentLength
        });
        
        // Start new chunk with overlap
        const words = currentChunk.split(' ');
        const overlapWords = words.slice(-Math.floor(this.chunkOverlap / 5)); // Approximate word overlap
        currentChunk = overlapWords.join(' ') + ' ' + sentence.trim();
        currentLength = currentChunk.length;
      } else {
        currentChunk += ' ' + sentence.trim();
        currentLength = currentChunk.length;
      }
    }

    // Add the last chunk if it has content
    if (currentChunk.trim().length > 0) {
      chunks.push({
        content: currentChunk.trim(),
        title: title,
        length: currentLength
      });
    }

    console.log(`📝 Created ${chunks.length} chunks from text`);
    return chunks;
  }

  cleanText(text) {
    return text
      .replace(/\s+/g, ' ') // Replace multiple whitespace with single space
      .replace(/\n+/g, ' ') // Replace newlines with space
      .replace(/[^\w\s.,!?;:()\-"']/g, '') // Remove special characters except basic punctuation
      .trim();
  }

  async processDocument(filePath, title = '', fileType = null) {
    try {
      // Use provided file type or detect from extension
      let extension;
      if (fileType) {
        extension = fileType.toLowerCase();
      } else {
        const pathParts = filePath.split('.');
        extension = pathParts.length > 1 ? pathParts.pop().toLowerCase() : '';
      }
      
      console.log(`📄 Processing document with type: ${extension}`);
      let result;

      switch (extension) {
        case 'pdf':
          result = await this.processPDF(filePath);
          break;
        case 'txt':
        case 'md':
          result = await this.processTextFile(filePath);
          break;
        case 'docx':
        case 'doc':
          result = await this.processWordFile(filePath);
          break;
        case 'xlsx':
        case 'xls':
          result = await this.processExcelFile(filePath);
          break;
        default:
          throw new Error(`Unsupported file type: ${extension} (from path: ${filePath})`);
      }

      // Clean the extracted text
      const cleanedText = this.cleanText(result.text);
      
      // Create chunks
      const chunks = this.chunkText(cleanedText, title || result.metadata.filename);
      
      return {
        chunks: chunks,
        metadata: result.metadata,
        originalText: cleanedText
      };
    } catch (error) {
      console.error('❌ Error processing document:', error);
      throw error;
    }
  }
}

module.exports = DocumentProcessor;
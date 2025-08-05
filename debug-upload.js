// debug-upload.js - Debug the upload issue
const DocumentProcessor = require('./knowledge-base/document-processor');
const fs = require('fs');

async function debugUpload() {
  console.log('🔍 Debugging upload issue...\n');

  // Create test PDF content
  const testContent = `%PDF-1.4
1 0 obj
<<
/Type /Catalog
/Pages 2 0 R
>>
endobj
xref
0 2
0000000000 65535 f 
0000000009 00000 n 
trailer
<<
/Size 2
/Root 1 0 R
>>
startxref
58
%%EOF`;

  // Write test file
  const testPath = './temp/debug-test';
  fs.writeFileSync(testPath, testContent);
  console.log('✅ Created test file:', testPath);

  try {
    const processor = new DocumentProcessor();
    
    console.log('🔄 Testing with fileType parameter...');
    const result = await processor.processDocument(testPath, 'Test Document', 'pdf');
    console.log('✅ Success! Processed document with', result.chunks.length, 'chunks');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Full error:', error);
  } finally {
    // Clean up
    try {
      fs.unlinkSync(testPath);
      console.log('✅ Cleaned up test file');
    } catch (cleanupError) {
      console.warn('⚠️ Could not clean up:', cleanupError.message);
    }
  }
}

debugUpload();
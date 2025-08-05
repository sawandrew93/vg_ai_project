// test-upload.js - Test the PDF upload functionality
require('dotenv').config();
const fs = require('fs');
const FormData = require('form-data');
const fetch = require('node-fetch');

async function testUpload() {
  console.log('🧪 Testing PDF Upload Functionality...\n');

  try {
    // First, login to get a token
    console.log('1. Logging in...');
    const loginResponse = await fetch('http://localhost:3000/api/agent/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username: 'john_doe',
        password: 'password123'
      })
    });

    const loginResult = await loginResponse.json();
    
    if (!loginResult.success) {
      console.error('❌ Login failed:', loginResult.error);
      return;
    }

    console.log('✅ Login successful');
    const token = loginResult.token;

    // Create a simple test PDF content (this is just for testing - in reality you'd use a real PDF)
    const testContent = `%PDF-1.4
1 0 obj
<<
/Type /Catalog
/Pages 2 0 R
>>
endobj

2 0 obj
<<
/Type /Pages
/Kids [3 0 R]
/Count 1
>>
endobj

3 0 obj
<<
/Type /Page
/Parent 2 0 R
/MediaBox [0 0 612 792]
/Contents 4 0 R
>>
endobj

4 0 obj
<<
/Length 44
>>
stream
BT
/F1 12 Tf
100 700 Td
(Test PDF Content) Tj
ET
endstream
endobj

xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000206 00000 n 
trailer
<<
/Size 5
/Root 1 0 R
>>
startxref
299
%%EOF`;

    // Write test PDF file
    const testPdfPath = './temp/test-document.pdf';
    fs.writeFileSync(testPdfPath, testContent);
    console.log('✅ Created test PDF file');

    // Test the upload
    console.log('2. Testing upload...');
    const form = new FormData();
    form.append('documents', fs.createReadStream(testPdfPath), {
      filename: 'test-document.pdf',
      contentType: 'application/pdf'
    });
    form.append('title', 'Test Document');

    const uploadResponse = await fetch('http://localhost:3000/api/knowledge-base/upload', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        ...form.getHeaders()
      },
      body: form
    });

    const uploadResult = await uploadResponse.json();
    
    if (uploadResponse.ok && uploadResult.success) {
      console.log('✅ Upload successful!');
      console.log(`📊 Processed: ${uploadResult.processedFiles}/${uploadResult.totalFiles} files`);
      
      if (uploadResult.results) {
        uploadResult.results.forEach(result => {
          if (result.success) {
            console.log(`   ✅ ${result.filename}: ${result.chunksInserted} chunks inserted`);
          } else {
            console.log(`   ❌ ${result.filename}: ${result.error}`);
          }
        });
      }
    } else {
      console.error('❌ Upload failed:', uploadResult.error || 'Unknown error');
      console.error('Response status:', uploadResponse.status);
    }

    // Clean up test file
    try {
      fs.unlinkSync(testPdfPath);
      console.log('✅ Cleaned up test file');
    } catch (error) {
      console.warn('⚠️ Could not clean up test file:', error.message);
    }

    // Test document retrieval
    console.log('3. Testing document retrieval...');
    const docsResponse = await fetch('http://localhost:3000/api/knowledge-base/documents?limit=5', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    const docs = await docsResponse.json();
    console.log(`✅ Retrieved ${docs.length} documents`);

    // Test stats
    console.log('4. Testing stats...');
    const statsResponse = await fetch('http://localhost:3000/api/knowledge-base/stats', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    const stats = await statsResponse.json();
    console.log(`✅ Stats: ${stats.totalDocuments} total documents`);
    console.log('   Source types:', Object.keys(stats.sourceTypes).join(', '));

    console.log('\n🎉 All tests completed successfully!');
    console.log('\n📋 Next steps:');
    console.log('   1. Visit: http://localhost:3000/kb-login');
    console.log('   2. Login with: john_doe / password123');
    console.log('   3. Upload your PDF files');
    console.log('   4. Test the chatbot at: http://localhost:3000');

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test
testUpload();
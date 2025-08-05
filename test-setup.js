// test-setup.js - Quick test to verify the setup
require('dotenv').config();

async function testSetup() {
  console.log('🧪 Testing AI Chatbot Knowledge Base Setup...\n');

  // Test 1: Environment Variables
  console.log('1. Testing environment variables...');
  const requiredEnvVars = ['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];
  let envOk = true;
  
  for (const envVar of requiredEnvVars) {
    if (process.env[envVar]) {
      console.log(`   ✅ ${envVar}: Set`);
    } else {
      console.log(`   ❌ ${envVar}: Missing`);
      envOk = false;
    }
  }

  if (!envOk) {
    console.log('\n❌ Environment setup incomplete. Please check your .env file.');
    return false;
  }

  // Test 2: Database Connection
  console.log('\n2. Testing database connection...');
  try {
    const KnowledgeBaseDB = require('./knowledge-base/database');
    const db = new KnowledgeBaseDB();
    const connected = await db.testConnection();
    
    if (connected) {
      console.log('   ✅ Database connection successful');
    } else {
      console.log('   ❌ Database connection failed');
      return false;
    }
  } catch (error) {
    console.log('   ❌ Database test error:', error.message);
    return false;
  }

  // Test 3: Embedding Generation
  console.log('\n3. Testing embedding generation...');
  try {
    const EmbeddingService = require('./knowledge-base/embeddings');
    const embeddingService = new EmbeddingService();
    const embedding = await embeddingService.generateEmbedding('Test sentence for embedding');
    
    if (embedding && embedding.length > 0) {
      console.log(`   ✅ Embedding generation successful (${embedding.length} dimensions)`);
    } else {
      console.log('   ❌ Embedding generation failed');
      return false;
    }
  } catch (error) {
    console.log('   ❌ Embedding test error:', error.message);
    return false;
  }

  // Test 4: Document Processing
  console.log('\n4. Testing document processor...');
  try {
    const DocumentProcessor = require('./knowledge-base/document-processor');
    const processor = new DocumentProcessor();
    const chunks = processor.chunkText('This is a test document. It has multiple sentences. Each sentence should be processed correctly.');
    
    if (chunks && chunks.length > 0) {
      console.log(`   ✅ Document processing successful (${chunks.length} chunks created)`);
    } else {
      console.log('   ❌ Document processing failed');
      return false;
    }
  } catch (error) {
    console.log('   ❌ Document processor test error:', error.message);
    return false;
  }

  console.log('\n🎉 All tests passed! Your setup is ready.');
  console.log('\n📋 Next steps:');
  console.log('   1. Run: npm run setup-kb');
  console.log('   2. Start server: npm start');
  console.log('   3. Visit: http://localhost:3000/knowledge-base');
  
  return true;
}

// Run the test
testSetup().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
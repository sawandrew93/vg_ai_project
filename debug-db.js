require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function debugDatabase() {
  console.log('🔍 Debugging Supabase database...\n');
  
  try {
    // 1. Check if documents table exists and get structure
    console.log('1. Checking documents table structure...');
    const { data: tableInfo, error: tableError } = await supabase
      .from('documents')
      .select('*')
      .limit(1);
    
    if (tableError) {
      console.error('❌ Table access error:', tableError);
      return;
    }
    
    console.log('✅ Table accessible');
    
    // 2. Count total documents
    const { count, error: countError } = await supabase
      .from('documents')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      console.error('❌ Count error:', countError);
    } else {
      console.log(`📊 Total documents: ${count}`);
    }
    
    // 3. Get sample documents to see structure
    const { data: samples, error: sampleError } = await supabase
      .from('documents')
      .select('*')
      .limit(3);
    
    if (sampleError) {
      console.error('❌ Sample query error:', sampleError);
    } else {
      console.log('\n📄 Sample documents:');
      samples.forEach((doc, i) => {
        console.log(`\n${i + 1}. Document structure:`);
        console.log('   Columns:', Object.keys(doc));
        if (doc.title) console.log('   Title:', doc.title);
        if (doc.content) console.log('   Content preview:', doc.content.substring(0, 100) + '...');
        if (doc.embedding) console.log('   Embedding length:', doc.embedding.length);
      });
    }
    
    // 4. Test if match_documents function exists
    console.log('\n4. Testing match_documents function...');
    try {
      const { data: funcTest, error: funcError } = await supabase.rpc('match_documents', {
        query_embedding: new Array(768).fill(0.1), // dummy embedding
        match_threshold: 0.1,
        match_count: 1
      });
      
      if (funcError) {
        console.error('❌ match_documents function error:', funcError);
        console.log('\n💡 You need to create the match_documents function in Supabase:');
        console.log(`
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding VECTOR(768),
  match_threshold FLOAT DEFAULT 0.3,
  match_count INT DEFAULT 5
)
RETURNS TABLE (
  id INT,
  title TEXT,
  content TEXT,
  metadata JSONB,
  similarity FLOAT
)
LANGUAGE SQL STABLE
AS $$
  SELECT
    documents.id,
    documents.title,
    documents.content,
    documents.metadata,
    1 - (documents.embedding <=> query_embedding) AS similarity
  FROM documents
  WHERE 1 - (documents.embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
$$;
        `);
      } else {
        console.log('✅ match_documents function works');
        console.log('   Results:', funcTest?.length || 0);
      }
    } catch (funcErr) {
      console.error('❌ Function test failed:', funcErr.message);
    }
    
  } catch (error) {
    console.error('❌ General error:', error);
  }
}

debugDatabase();
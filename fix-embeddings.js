require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function generateEmbedding(text) {
  const result = await embeddingModel.embedContent(text);
  return result.embedding.values;
}

async function fixEmbeddings() {
  console.log('🔄 Re-embedding documents with Gemini...');
  
  const { data: docs } = await supabase.from('documents').select('id, content').limit(10);
  
  for (const doc of docs) {
    console.log(`Processing doc ${doc.id}...`);
    const newEmbedding = await generateEmbedding(doc.content);
    
    await supabase.from('documents').update({ 
      embedding: newEmbedding 
    }).eq('id', doc.id);
    
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('✅ Done! Update your SQL function to use VECTOR(768)');
}

fixEmbeddings();
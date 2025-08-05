// knowledge-base/embeddings.js
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Gemini AI with the latest model
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

class EmbeddingService {
  constructor() {
    // Use Gemini Embeddings 001 model
    this.embeddingModel = genAI.getGenerativeModel({ 
      model: "text-embedding-004" 
    });
  }

  async generateEmbedding(text) {
    try {
      if (!text || text.trim().length === 0) {
        throw new Error('Text cannot be empty');
      }

      // Clean and prepare text
      const cleanText = text.trim().replace(/\s+/g, ' ');
      
      const result = await this.embeddingModel.embedContent(cleanText);
      const embedding = result.embedding.values;
      
      if (!embedding || embedding.length === 0) {
        throw new Error('Failed to generate embedding');
      }

      console.log(`✅ Generated embedding with ${embedding.length} dimensions`);
      return embedding;
    } catch (error) {
      console.error('❌ Error generating embedding:', error);
      throw error;
    }
  }

  async generateBatchEmbeddings(texts, batchSize = 5) {
    const results = [];
    
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(texts.length/batchSize)}`);
      
      const batchPromises = batch.map(async (text, index) => {
        try {
          const embedding = await this.generateEmbedding(text);
          return { success: true, embedding, originalIndex: i + index };
        } catch (error) {
          console.error(`Failed to generate embedding for text ${i + index}:`, error);
          return { success: false, error: error.message, originalIndex: i + index };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      
      // Rate limiting delay
      if (i + batchSize < texts.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return results;
  }
}

module.exports = EmbeddingService;
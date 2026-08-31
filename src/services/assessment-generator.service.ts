import OpenAI from 'openai';
import crypto from 'crypto';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'dummy_key_for_build',
  timeout: 60 * 1000,
});

export interface DynamicQuestionOption {
  id: string;
  text: string;
  isCorrect: boolean;
}

export interface DynamicGeneratedQuestion {
  id: string;
  questionText: string;
  options: DynamicQuestionOption[];
  explanation: string;
}

export interface QuizGenerationResult {
  sessionId: string;
  specialty: string;
  questions: DynamicGeneratedQuestion[];
}

export class AssessmentGeneratorService {
  private generatedHashes = new Set<string>();

  private hashQuestion(text: string): string {
    return crypto.createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
  }

  private shuffleOptions(options: DynamicQuestionOption[]): DynamicQuestionOption[] {
    const shuffled = [...options];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  private buildSystemPrompt(sessionId: string, specialtyName: string, requestedCount: number): string {
    return `You are a Principal AI Technical Assessor.
Your task is to generate EXACTLY ${requestedCount} advanced, scenario-based multiple-choice questions for a professional provider.
The quiz MUST be explicitly tailored to the provider's detected tech stack and work samples.
Strict Anti-Duplication: Every question must cover a unique topic/concept. Do NOT repeat questions.
Return the result in JSON format ONLY, matching this schema:
{
  "sessionId": "${sessionId}",
  "specialty": "${specialtyName}",
  "questions": [
    {
      "id": "q_gen_1",
      "questionText": "string (Arabic)",
      "options": [
        { "id": "opt_a", "text": "string", "isCorrect": true },
        { "id": "opt_b", "text": "string", "isCorrect": false },
        { "id": "opt_c", "text": "string", "isCorrect": false },
        { "id": "opt_d", "text": "string", "isCorrect": false }
      ],
      "explanation": "string"
    }
  ]
}`;
  }

  async generateDynamicQuiz(
    sessionId: string,
    specialtyName: string,
    subSpecialties: string[],
    contextData: any
  ): Promise<QuizGenerationResult> {
    const validatedQuestions: DynamicGeneratedQuestion[] = [];
    let attempts = 0;
    const MAX_ATTEMPTS = 3;
    let questionsNeeded = 20;

    while (questionsNeeded > 0 && attempts < MAX_ATTEMPTS) {
      attempts++;
      
      const userContent = `Provider Specialty: ${specialtyName}
Sub-Specialties: ${subSpecialties.join(', ')}
Work Sample Context: ${JSON.stringify(contextData)}
Generate ${questionsNeeded} unique scenario-based questions in Arabic.`;

      try {
        const aiResponse = await openai.chat.completions.create({
          model: 'gpt-4o-2024-08-06',
          temperature: 0.3,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: this.buildSystemPrompt(sessionId, specialtyName, questionsNeeded) },
            { role: 'user', content: userContent },
          ]
        });

        const content = aiResponse.choices[0].message?.content || '{}';
        const aiResult = JSON.parse(content) as QuizGenerationResult;

        if (aiResult && aiResult.questions) {
          for (const q of aiResult.questions) {
            if (questionsNeeded === 0) break;

            const qHash = this.hashQuestion(q.questionText);
            if (this.generatedHashes.has(qHash)) {
              console.warn(`[AssessmentGenerator] Duplicate question detected and discarded: ${qHash}`);
              continue; 
            }
            this.generatedHashes.add(qHash);

            // Fisher-Yates shuffle the options
            q.options = this.shuffleOptions(q.options);
            
            validatedQuestions.push(q);
            questionsNeeded--;
          }
        }
      } catch (error) {
        console.error('[AssessmentGenerator] AI Generation Attempt Failed:', error);
      }
    }

    if (validatedQuestions.length === 0) {
      throw new Error('AI Generation failed to produce any valid questions. No static fallback allowed.');
    }

    return {
      sessionId,
      specialty: specialtyName,
      questions: validatedQuestions
    };
  }
}

export const assessmentGeneratorService = new AssessmentGeneratorService();

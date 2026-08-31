import { prisma } from '../config/db';

export class AssessmentService {
  /**
   * Helper to randomly shuffle an array and pick a specific number of unique items
   */
  private shuffleAndPickUnique(array: any[], size: number) {
    // Fisher-Yates shuffle
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    // Pick unique items
    const uniqueMap = new Map();
    for (const item of shuffled) {
      if (!uniqueMap.has(item.id)) {
        uniqueMap.set(item.id, item);
      }
      if (uniqueMap.size === size) break;
    }
    
    return Array.from(uniqueMap.values());
  }

  /**
   * Generates a unique quiz for a provider based on their specialty
   */
  async generateUniqueQuiz(specialtyId: string, subSpecialties: string[], quizSize: number = 20) {
    // Fetch pool of questions for the given specialty
    const availableQuestions = await prisma.question.findMany({
      where: { specialtyId, isActive: true },
    });

    if (availableQuestions.length === 0) {
      return []; // Return empty so controller handles fallback
    }

    // Apply Fisher-Yates shuffle & slice or distinct picking
    const uniqueQuestions = this.shuffleAndPickUnique(availableQuestions, quizSize);
    
    return uniqueQuestions.map(q => ({
      id: q.id,
      subSpecialtyTag: q.subSpecialtyTag || subSpecialties[0] || 'عام',
      text: q.text,
      options: typeof q.options === 'string' ? JSON.parse(q.options) : q.options,
      correctOptionIndex: q.correctOptionIndex,
      explanation: q.explanation
    }));
  }
}

export const assessmentService = new AssessmentService();

import { Socket } from 'socket.io';
import { AccreditationAiService } from '../services/accreditation-ai.service';
import { logger } from '../config/logger';

const accreditationAiService = new AccreditationAiService();

export const registerAccreditationAiGateway = (socket: Socket) => {
  socket.on('client:analyze-proof-image', async (data: { proofFileId: string; specialtyName: string }) => {
    logger.info(`Received client:analyze-proof-image for ${data.proofFileId}`);
    try {
      socket.emit('server:ai-analysis-started', { proofFileId: data.proofFileId });

      const result = await accreditationAiService.processProofImage(
        data.proofFileId,
        data.specialtyName,
        (progress) => {
          socket.emit('server:ai-analysis-progress', {
            proofFileId: data.proofFileId,
            progress,
          });
        },
      );

      socket.emit('server:ai-analysis-completed', {
        proofFileId: data.proofFileId,
        result,
      });
    } catch (error: any) {
      socket.emit('server:ai-analysis-error', {
        proofFileId: data.proofFileId,
        error: error.message,
      });
    }
  });
};

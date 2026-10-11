// ONE definition of the specialty test, used by BOTH flows (the setup / registration test in sockets/setup-test.gateway.ts and the later specialty test in
// services/ai-assessment.service.ts): the same number of questions, the same time limit and the same pass floor. The test proves a pass only; it never approves a
// specialty (the admin decides).
export const SPECIALTY_TEST_QUESTION_COUNT = 15;
export const SPECIALTY_TEST_TIME_LIMIT_MINUTES = 15;
/** Score (%) above which a test counts as passed. */
export const SPECIALTY_TEST_PASS_SCORE = 25;

/** API chỉ lộ metadata an toàn; payload và RabbitMQ headers không rời khỏi Report. */
export interface DeadLetterAttempt {
  id: string;
  actorId: string;
  status:
    'REQUESTED' | 'REPUBLISHED' | 'PUBLISH_FAILED' | 'PUBLISH_UNCONFIRMED' | 'PROCESSING_FAILED';
  requestedAt: string;
  publishedAt: string | null;
  failureCode: string | null;
}

export interface DeadLetterMessage {
  id: string;
  sourceQueue: string;
  sourceService: string;
  routingKey: string | null;
  deadLetterQueue: string;
  eventType: string | null;
  eventId: string | null;
  correlationId: string | null;
  failureKind: string;
  failureReason: string;
  retryCount: number | null;
  failedAt: string;
  replayCount: number;
  replayable: boolean;
  attempts: DeadLetterAttempt[];
}

export interface DeadLetterPage {
  page: number;
  pageSize: number;
  total: number;
  items: DeadLetterMessage[];
}

export interface DeadLetterReplayResult {
  attemptId: string;
  status: 'REPUBLISHED';
  message: string;
}

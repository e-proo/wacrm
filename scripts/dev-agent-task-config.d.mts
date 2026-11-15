export declare const DEV_TASK_TEST_URL: string
export declare function shouldRunDevTaskWorker(input: {
  nodeEnv?: string
  supabaseUrl?: string
  mode?: string
}): boolean
export declare function developmentPort(args: readonly string[]): number

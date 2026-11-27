import {describe,it,expect} from 'vitest'
import {scopedVideoMime,validVideoSize,hasVideoContainer,VIDEO_LIMIT} from './scoped-video-upload'
import {aiConversationPatch} from '@/lib/ai/conversation-control'
describe('scoped video and AI control contracts',()=>{
 it('accepts known MP4 and 3GP MIME/extension pairs, not renamed arbitrary files',()=>{
  expect(scopedVideoMime('test.MP4','')).toBe('video/mp4')
  expect(scopedVideoMime('test.3gp','video/3gp')).toBe('video/3gpp')
  expect(scopedVideoMime('test.mp4','image/png')).toBeNull()
  expect(scopedVideoMime('test.exe','video/mp4')).toBeNull()
  expect(validVideoSize(VIDEO_LIMIT)).toBe(true)
  expect(validVideoSize(VIDEO_LIMIT+1)).toBe(false)
  expect(hasVideoContainer(Uint8Array.from([0,0,0,20,102,116,121,112,0,0,0,0]))).toBe(true)
  expect(hasVideoContainer(new Uint8Array(20))).toBe(false)
 })
 it('preserves original parent takeover and resume semantics',()=>{
  expect(aiConversationPatch(true,'actor')).toEqual({ai_autoreply_disabled:true,assigned_agent_id:'actor'})
  expect(aiConversationPatch(false,'actor')).toEqual({ai_autoreply_disabled:false,assigned_agent_id:null,ai_reply_count:0,ai_handoff_summary:null})
 })
})

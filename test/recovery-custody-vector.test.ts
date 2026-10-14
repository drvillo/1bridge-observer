import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as authority from '@drvillo/1bridge-authority'

const bytes = readFileSync(new URL('./recovery-custody-v1.json', import.meta.url))
const vector = JSON.parse(bytes.toString('utf8'))

describe('pinned enterprise recovery-custody vector', () => {
  it('accepts the reset under the prior recovery key and rejects the prior routine root', async () => {
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('dc75ac898b486428b20754b4cedc5affbbef16623f671a9d23b182809f5dfe09')
    const recovery = await authority.importSigningPublicKey(vector.signedAnchor.anchor.recoveryKeySpki)
    const oldRoot = await authority.importSigningPublicKey(vector.signedAnchor.anchor.rootKeySpki)
    expect(await authority.verifyRecord('authority.revision', vector.resetRevision.statement,
      vector.resetRevision.signature, recovery)).toBe(true)
    expect(await authority.verifyRecord('authority.revision', vector.oldRootRevision.statement,
      vector.oldRootRevision.signature, oldRoot)).toBe(true)
    const initial = await authority.verifyAuthorityAnchor(vector.signedAnchor, vector.anchorPin)
    const accepted = await authority.applyAuthorityRevision(initial, vector.resetRevision)
    expect(authority.authorityStateSnapshot(accepted)).toMatchObject(vector.expectedAfterReset)
    await expect(authority.applyAuthorityRevision(accepted, vector.oldRootRevision)).rejects.toThrow()
  })
})

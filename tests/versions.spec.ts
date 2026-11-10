import { describe, expect, it } from 'vitest'
import {
  isNewerVersion,
  latestStableTag,
  nextFormalVersion,
  nextNightlyVersion,
} from '../scripts/next-versions.js'

describe('nextFormalVersion', () => {
  it('bumps the patch segment', () => {
    expect(nextFormalVersion('0.0.1')).toBe('0.0.2')
    expect(nextFormalVersion('1.2.9')).toBe('1.2.10')
    expect(nextFormalVersion('2.0.0')).toBe('2.0.1')
  })

  it('drops a prerelease suffix before bumping', () => {
    expect(nextFormalVersion('0.0.2-nightly.20261110.abc1234')).toBe('0.0.3')
  })
})

describe('nextNightlyVersion', () => {
  it('builds a semver prerelease below the next formal version', () => {
    expect(nextNightlyVersion('0.0.1', '20261110', '22f0b46')).toBe(
      '0.0.2-nightly.20261110.22f0b46',
    )
    expect(nextNightlyVersion('0.0.2', '20261111', 'deadbee')).toBe(
      '0.0.3-nightly.20261111.deadbee',
    )
  })
})

describe('latestStableTag', () => {
  it('ignores prereleases and sorts numerically', () => {
    expect(
      latestStableTag(['v7.0.10', 'v7.0.9', 'v7.1.0-beta.1', 'v7.0.2']),
    ).toBe('v7.0.10')
  })

  it('returns undefined when no stable tag exists', () => {
    expect(latestStableTag(['v7.1.0-rc.1', 'nope'])).toBeUndefined()
  })
})

describe('isNewerVersion', () => {
  it('compares numeric segments after stripping v', () => {
    expect(isNewerVersion('v7.0.10', '7.0.9')).toBe(true)
    expect(isNewerVersion('v7.0.2', '7.0.2')).toBe(false)
    expect(isNewerVersion('v7.0.1', '7.0.2')).toBe(false)
    expect(isNewerVersion('v8.0.0', '7.9.9')).toBe(true)
  })
})

import { useTranslation } from 'react-i18next'
import GhostShield from './GhostShield'
import { Icon } from './icons'

interface Props {
  token: string
  themeMode: 'dark' | 'light'
  onToggleTheme: () => void
  onClose: () => void
  onOpenApiConfig: () => void
}

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ru', label: 'Русский' },
]

export default function GeneralSettings({ themeMode, onToggleTheme, onClose, onOpenApiConfig }: Props) {
  const { t, i18n } = useTranslation()

  function handleLanguageChange(e: React.ChangeEvent<HTMLSelectElement>) {
    i18n.changeLanguage(e.target.value)
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-5">
      <GhostShield />
      <div className="bg-nexus-bg border border-nexus-border rounded-xl flex flex-col text-nexus-text w-full max-w-[400px] shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-nexus-border">
          <span className="text-base font-semibold">{t('settings.title')}</span>
          <button
            className="bg-transparent border-none text-nexus-text-2 cursor-pointer flex items-center justify-center"
            onPointerDown={onClose}
          >
            <Icon name="x" size={20} />
          </button>
        </div>

        <div className="px-4 py-4 flex flex-col gap-5">
          {/* Appearance section */}
          <div>
            <div className="text-[11px] text-nexus-text-2 tracking-wider uppercase mb-3">
              {t('settings.appearance')}
            </div>

            {/* Language */}
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-nexus-text">{t('settings.language')}</span>
              <select
                className="bg-nexus-bg-2 border border-nexus-border rounded-md text-nexus-text text-sm px-2.5 py-1.5 outline-none cursor-pointer"
                value={i18n.language}
                onChange={handleLanguageChange}
              >
                {LANGUAGES.map(lang => (
                  <option key={lang.code} value={lang.code}>{lang.label}</option>
                ))}
              </select>
            </div>

            {/* Theme */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-nexus-text">{t('settings.theme')}</span>
              <div className="flex gap-1">
                <button
                  className={`text-sm px-3 py-1.5 rounded-md border-none cursor-pointer transition-colors ${themeMode === 'dark' ? 'bg-nexus-accent text-white' : 'bg-nexus-bg-2 text-nexus-text-2'}`}
                  onPointerDown={themeMode !== 'dark' ? onToggleTheme : undefined}
                >
                  {t('settings.themeDark')}
                </button>
                <button
                  className={`text-sm px-3 py-1.5 rounded-md border-none cursor-pointer transition-colors ${themeMode === 'light' ? 'bg-nexus-accent text-white' : 'bg-nexus-bg-2 text-nexus-text-2'}`}
                  onPointerDown={themeMode !== 'light' ? onToggleTheme : undefined}
                >
                  {t('settings.themeLight')}
                </button>
              </div>
            </div>
          </div>

          {/* API Config Profiles section */}
          <div className="border-t border-nexus-border pt-4">
            <div className="text-[11px] text-nexus-text-2 tracking-wider uppercase mb-3">
              {t('settings.apiProfiles')}
            </div>
            <p className="text-sm text-nexus-text-2 mb-3">
              {t('settings.apiProfilesDesc')}
            </p>
            <button
              className="flex items-center gap-1.5 bg-transparent border border-nexus-border rounded-md text-nexus-text text-sm px-3 py-2 cursor-pointer"
              onPointerDown={onOpenApiConfig}
            >
              <span>{t('settings.manageProfiles')}</span>
              <Icon name="arrowRight" size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

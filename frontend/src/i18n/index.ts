import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import en from '../locales/en/translation.json'
import zhCN from '../locales/zh-CN/translation.json'
import ja from '../locales/ja/translation.json'
import ko from '../locales/ko/translation.json'
import es from '../locales/es/translation.json'
import fr from '../locales/fr/translation.json'
import de from '../locales/de/translation.json'
import ru from '../locales/ru/translation.json'

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      'zh-CN': { translation: zhCN },
      ja: { translation: ja },
      ko: { translation: ko },
      es: { translation: es },
      fr: { translation: fr },
      de: { translation: de },
      ru: { translation: ru },
    },
    fallbackLng: 'en',
    supportedLngs: ['en', 'zh-CN', 'ja', 'ko', 'es', 'fr', 'de', 'ru'],
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'nexus_language',
    },
    interpolation: { escapeValue: false },
  })

export default i18n

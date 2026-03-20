Pod::Spec.new do |s|
  s.name         = 'CapacitorCalendar'
  s.version      = '1.0.0'
  s.summary      = 'Native iOS Calendar (EventKit) plugin for Capacitor'
  s.license      = 'MIT'
  s.homepage     = 'https://github.com/nicepkg/capacitor-calendar'
  s.author       = 'Notes App'
  s.source       = { :git => 'https://github.com/nicepkg/capacitor-calendar.git', :tag => s.version.to_s }
  s.source_files = 'ios/Plugin/**/*.{swift,h,m}'
  s.ios.deployment_target = '14.0'
  s.swift_version = '5.9'
  s.dependency 'Capacitor'
  s.frameworks   = 'EventKit'
end

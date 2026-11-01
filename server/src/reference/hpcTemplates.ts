/**
 * The Holistic Progress Card templates NES prescribes, as the schools print them today: Balvatika
 * (developmental goals rated in stars), Classes I and II (curriculum goals rated as plants, with
 * self and peer assessment in smileys) and Classes III to V (PARAKH preparatory: how I feel at
 * school, subject competencies, observations, peer and learner feedback).
 *
 * Taken from the NCS / Naval Kindergarten report cards (Session 2026-27). These are the NES
 * defaults; NES can change a class's template from the HPC templates screen, and the saved copy
 * replaces the default. Item ids never change once given, so ratings stay attached to them.
 * Generated from the sample cards; edit through the app rather than by hand.
 */

export interface HpcItem { id: string; text: string }
export interface HpcGroup { id: string; title: string; items: HpcItem[] }
export type HpcPart =
  | { kind: 'STARS'; id: string; tag: string; groups: HpcGroup[] }
  | { kind: 'GOALS'; id: string; tag: string; groups: HpcGroup[] }
  | { kind: 'SMILEYS'; id: string; title: string; groups: HpcGroup[] }
  | { kind: 'CHOICE'; id: string; tag?: string; title: string; scale: string[]; items: HpcItem[] }
  | { kind: 'SUBJECT'; id: string; tag?: string; title: string; groups: HpcGroup[] }
  | { kind: 'YESNO'; id: string; tag?: string; title: string; items: HpcItem[] }
  | { kind: 'TEXT'; id: string; title: string; items: HpcItem[] };
export type Glimpse = 'FAMILY' | 'SELF' | 'PORTFOLIO';
export interface HpcTemplate { stage: 'BALVATIKA' | 'FOUNDATIONAL' | 'PREPARATORY'; favourites: HpcItem[]; glimpses: Glimpse[]; parts: HpcPart[] }

/** Classes that use a holistic card instead of a marks card. */
export const HPC_CLASSES = ['BV1', 'BV2', 'BV3', 'I', 'II', 'III', 'IV', 'V'];

const PREPARATORY: HpcTemplate = {
 "stage": "PREPARATORY",
 "favourites": [
  {
   "id": "f.1",
   "text": "My favourite book/poem/song/story is"
  },
  {
   "id": "f.2",
   "text": "I love to eat"
  },
  {
   "id": "f.3",
   "text": "My favourite people are"
  },
  {
   "id": "f.4",
   "text": "I love to participate in"
  },
  {
   "id": "f.5",
   "text": "I do not like"
  },
  {
   "id": "f.6",
   "text": "How do I cope with it?"
  },
  {
   "id": "f.7",
   "text": "I want to know more about"
  }
 ],
 "glimpses": [
  "SELF"
 ],
 "parts": [
  {
   "kind": "CHOICE",
   "id": "1",
   "tag": "Part A",
   "title": "How do I feel at School",
   "scale": [
    "Not Sure",
    "Sometimes",
    "No",
    "Yes"
   ],
   "items": [
    {
     "id": "1.0.1",
     "text": "I can talk about how I feel (happy, confident, upset, angry etc)."
    },
    {
     "id": "1.0.2",
     "text": "In a difficult situation, I am able to stay calm."
    },
    {
     "id": "1.0.3",
     "text": "I understand how my friends feel."
    },
    {
     "id": "1.0.4",
     "text": "When someone is sad, I can make them feel better."
    }
   ]
  },
  {
   "kind": "SUBJECT",
   "id": "2",
   "title": "LANGUAGE-R1",
   "groups": [
    {
     "id": "2.1",
     "title": "Develops oral language skills using complex sentence structures to understand and communicate ideas coherently.",
     "items": [
      {
       "id": "2.1.1",
       "text": "Converses fluently and meaningfully in different contexts."
      },
      {
       "id": "2.1.2",
       "text": "Summarises core ideas from material read out in class."
      },
      {
       "id": "2.1.3",
       "text": "Makes oral presentations (show and tell, short welcome notes, anchoring of small events, short speeches, class debates)."
      }
     ]
    },
    {
     "id": "2.2",
     "title": "Develops the ability to read with comprehension by gaining a basic understanding of different forms of familiar and unfamiliar texts (such as prose and poetry).",
     "items": [
      {
       "id": "2.2.1",
       "text": "Applies varied comprehension strategies (inferring, predicting, visualising) to understand different texts."
      },
      {
       "id": "2.2.2",
       "text": "Understands main ideas and draws essential conclusions from the material read."
      }
     ]
    },
    {
     "id": "2.3",
     "title": "Develops the ability to write simple and compound sentence structures to express their understanding and experiences.",
     "items": [
      {
       "id": "2.3.1",
       "text": "Uses writing strategies, such as sequencing, identifying headings/sub-headings, the beginning, and ending, and forming paragraphs."
      },
      {
       "id": "2.3.2",
       "text": "Writes clear and coherent paragraphs that convey their understanding of a given topic/concept or on a reading of a text."
      },
      {
       "id": "2.3.3",
       "text": "Creates posters, invites, simple poems, stories, and dialogues with appropriate information and purpose."
      },
      {
       "id": "2.3.4",
       "text": "Uses appropriate grammar and structure in their writing."
      }
     ]
    },
    {
     "id": "2.4",
     "title": "Acquires a more comprehensive range of words in various contexts (of home and school experience) through different sources.",
     "items": [
      {
       "id": "2.4.1",
       "text": "Discusses meanings of words and develops vocabulary by listening to and reading a variety of texts or other content areas."
      },
      {
       "id": "2.4.2",
       "text": "Discusses meanings of words and develops vocabulary by listening to and reading a variety of texts."
      }
     ]
    },
    {
     "id": "2.5",
     "title": "Develops interest and preferences in reading.",
     "items": [
      {
       "id": "2.5.1",
       "text": "Borrows books from the library regularly to read at home."
      },
      {
       "id": "2.5.2",
       "text": "Demonstrates interest in reading books from the library."
      }
     ]
    }
   ],
   "tag": "Part B"
  },
  {
   "kind": "SUBJECT",
   "id": "3",
   "title": "LANGUAGE-R2",
   "groups": [
    {
     "id": "3.1",
     "title": "Sustains effective communication skills for day-to-day interactions, enhancing their oral ability to express ideas.",
     "items": [
      {
       "id": "3.1.1",
       "text": "Listens to poems, stories, and conversations and locates important ideas in them."
      },
      {
       "id": "3.1.2",
       "text": "Comprehends narrated/read out stories and identifies characters, storyline, and key aspects."
      },
      {
       "id": "3.1.3",
       "text": "Converses meaningfully and coherently"
      },
      {
       "id": "3.1.4",
       "text": "Makes oral presentations and participates in group discussions."
      }
     ]
    },
    {
     "id": "3.2",
     "title": "Develops fluency in reading and the ability to read with comprehension.",
     "items": [
      {
       "id": "3.2.1",
       "text": "Develops phonological awareness further by blending phonemes/ syllables into words and segmenting words into phonemes/ syllables."
      },
      {
       "id": "3.2.2",
       "text": "Examines the basic structure of the text and recognises words and sentences in print and basic punctuation marks."
      },
      {
       "id": "3.2.3",
       "text": "Reads stories and passages fluently and accurately with appropriate pauses."
      },
      {
       "id": "3.2.4",
       "text": "Comprehends the meaning of stories, poems, and story posters."
      },
      {
       "id": "3.2.5",
       "text": "Demonstrates interest in picking up and reading a variety of children’s books."
      }
     ]
    },
    {
     "id": "3.3",
     "title": "Develops the ability to express understanding, experiences, feelings, and ideas in writing.",
     "items": [
      {
       "id": "3.3.1",
       "text": "Writes a paragraph to express understanding and experiences."
      },
      {
       "id": "3.3.2",
       "text": "Creates simple posters, invites, and instructions with appropriate information and purpose."
      },
      {
       "id": "3.3.3",
       "text": "Writes stories, poems, and conversations based on imagination and experiences."
      }
     ]
    },
    {
     "id": "3.4",
     "title": "Develops a wide range of vocabulary in various contexts and through different sources.",
     "items": [
      {
       "id": "3.4.1",
       "text": "Discusses meanings of words and develops vocabulary by listening to and reading a variety of texts or other content areas."
      }
     ]
    }
   ]
  },
  {
   "kind": "SUBJECT",
   "id": "4",
   "title": "MATHEMATICS",
   "groups": [
    {
     "id": "4.1",
     "title": "Understands numbers (counting numbers and fractions), represents whole numbers using the Indian place value system, understands and carries out the four basic operations with whole numbers, and discovers and recognises patterns in number sequences.",
     "items": [
      {
       "id": "4.1.1",
       "text": "Represents numbers using the place value structure of the Indian number system, compares whole numbers, and knows and can read the names of very large numbers."
      },
      {
       "id": "4.1.2",
       "text": "Represents and compares commonly used fractions in daily life (such as ½, ¼, etc.) as parts of unit wholes, as locations on number lines, and as divisions of whole numbers."
      },
      {
       "id": "4.1.3",
       "text": "Understands and visualises arithmetic operations and the relationships among them, knows addition and multiplication tables at least up to 10x10 and applies the four basic operations on whole numbers to solve daily life problems."
      },
      {
       "id": "4.1.4",
       "text": "Recognises, describes, and extends simple number patterns such as odd numbers, even numbers, square numbers, cubes, powers of 2, powers of 10, and Virahanka–Fibonacci numbers."
      }
     ]
    },
    {
     "id": "4.2",
     "title": "Analyses the characteristics and properties of two and three-dimensional geometric shapes, specifies locations and describes spatial relationships, and recognises and creates shapes that have symmetry.",
     "items": [
      {
       "id": "4.2.1",
       "text": "Identifies, compares, and analyses attributes of two- and three-dimensional shapes and develops vocabulary to describe their attributes/properties."
      },
      {
       "id": "4.2.2",
       "text": "Describes location and movement using both common language and mathematical vocabulary; understands the notion of map."
      },
      {
       "id": "4.2.3",
       "text": "Recognises and creates symmetry (reflection, rotation) in familiar 2D and 3D shapes."
      },
      {
       "id": "4.2.4",
       "text": "Discovers, recognises, describes, and extends patterns in 2D and 3D shapes."
      }
     ]
    },
    {
     "id": "4.3",
     "title": "Understands measurable attributes of objects and the units, systems, and processes of such measurement, including those related to distance, length, weight, area, volume, and time using non standard and standard units.",
     "items": [
      {
       "id": "4.3.1",
       "text": "Measures in non-standard and standard units and evaluates the need for standard units."
      },
      {
       "id": "4.3.2",
       "text": "Uses an appropriate unit and tool for the attribute (like length, perimeter, time, weight, volume) being measured."
      },
      {
       "id": "4.3.3",
       "text": "Carries out simple unit conversions, such as from centimetres to metres, within a system of measurement."
      },
      {
       "id": "4.3.4",
       "text": "Understands the definition and formula for the area of a square or rectangle as length times breadth."
      },
      {
       "id": "4.3.5",
       "text": "Devises strategies for estimating the distance, length, time, perimeter (for regular and irregular shapes), area (for regular and irregular shapes), weight and volume and verifies the same using standard units."
      },
      {
       "id": "4.3.6",
       "text": "Deduces that shapes having equal areas can have different perimeters and shapes having equal perimeters can have different areas."
      },
      {
       "id": "4.3.7",
       "text": "Evaluates the conservation of attributes like length and volume and solves daily-life problems related to them."
      }
     ]
    },
    {
     "id": "4.4",
     "title": "Develops problem-solving skills with procedural fluency to solve mathematical puzzles as well as daily-life problems, and as a step towards developing computational thinking.",
     "items": [
      {
       "id": "4.4.1",
       "text": "Solves puzzles and daily-life problems involving one or more operations on whole numbers (including word puzzles and puzzles from ‘recreational’ areas, such as the construction of magic squares)."
      },
      {
       "id": "4.4.2",
       "text": "Learns to systematically count and list all possible permutations or combination given a constraint, in simple situations (e.g., how to make a committee of two people from a group of five people)."
      },
      {
       "id": "4.4.3",
       "text": "Selects appropriate methods and tools for computing with whole numbers, such as mental computation, estimation, or paper pencil calculation, in accordance with the context."
      }
     ]
    },
    {
     "id": "4.5",
     "title": "Knows and appreciates the development in India of the decimal place value system that is used around the world today.",
     "items": [
      {
       "id": "4.5.1",
       "text": "Understands the development of zero in India and the Indian place value system for writing numerals, the history of its transmission to the world, and its modern impact on our lives and in all technology."
      }
     ]
    }
   ]
  },
  {
   "kind": "SUBJECT",
   "id": "5",
   "title": "THE WORLD AROUND US",
   "groups": [
    {
     "id": "5.1",
     "title": "Explores and engages with the natural and socio-cultural environment in their surroundings",
     "items": [
      {
       "id": "5.1.1",
       "text": "Observes and identifies the natural (insects, plants, birds, animals, geographical features, sun and moon, stars, planets, natural resources) and social (houses, relationships) components in their immediate environment."
      },
      {
       "id": "5.1.2",
       "text": "Describes relationships (including between humans and animals/ nature) and traditions (art forms, celebrations, festivals) in the family and community."
      },
      {
       "id": "5.1.3",
       "text": "Asks questions and makes predictions about simple patterns (season change, food chain, phases of the moon, movement of stars and planets, shapes of trees, plants, leaves, and flowers, rituals, celebrations) observed in the immediate environment."
      },
      {
       "id": "5.1.4",
       "text": "Explains the functioning of local institutions (family, school, bank/post office, market, and panchayat) in different forms (story, drawing, tabulating data, reports), and analyses their roles."
      },
      {
       "id": "5.1.5",
       "text": "Uses local materials to create simple objects (family tree, envelopes, origami animals) on their own for display or use in classroom processes."
      }
     ]
    },
    {
     "id": "5.2",
     "title": "Understands the interdependence in their environment through observation and experiences, developing the basis for appreciation of the idea of ‘Vasudhaiva Kutumbakam’.",
     "items": [
      {
       "id": "5.2.1",
       "text": "Identifies natural and humanmade systems that support their lives (water supply, water cycle, river flow systems, seasons, life cycle of plants and animals, food, household items, transport, communication, electricity in the home)."
      },
      {
       "id": "5.2.2",
       "text": "Describes the relationship between the natural environment and cultural practices in immediate environment (nature of work, food, festivals, traditions)."
      },
      {
       "id": "5.2.3",
       "text": "Connects changes in the environment and the lives of family and community, as communicated by elders and through local stories (changes in occupation, food habits, resources, celebrations, communication)."
      }
     ]
    },
    {
     "id": "5.3",
     "title": "Explains how to ensure the safety of self and others in different (normal as well as emergency) situations.",
     "items": [
      {
       "id": "5.3.1",
       "text": "Describes the basic safety needs and protection (health and hygiene, food, water, shelter, precautions, awareness of emergency situations, abuse, and unsafe situations) of humans, birds, and animals."
      },
      {
       "id": "5.3.2",
       "text": "Discusses how to prepare for emergency situations (smoke, fire, small injuries, burns, electrical safety, unseasonal rains, fallen trees) based on discussions with family and community, or personal experiences."
      },
      {
       "id": "5.3.3",
       "text": "Develops simple labels and slogans, and participates in roleplay on safety and protection in the local environment to be displayed/done in school and locality."
      }
     ]
    },
    {
     "id": "5.4",
     "title": "Develops sensitivity towards social and natural environment.",
     "items": [
      {
       "id": "5.4.1",
       "text": "Observes and describes diversity among plants, and birds and animals in immediate environment (shape, sounds, food habits, growth, habitat)."
      },
      {
       "id": "5.4.2",
       "text": "Observes and describes cultural diversity in their immediate environment (food, clothing, games, different seasons, festivals related to harvest and sowing)."
      },
      {
       "id": "5.4.3",
       "text": "Describes usage of natural resources in their immediate environment."
      },
      {
       "id": "5.4.4",
       "text": "Demonstrates how natural resources can be shared, maintained, and conserved (trees, use of rainwater, benefits of millets)."
      },
      {
       "id": "5.4.5",
       "text": "Identifies needs of plants, birds, and animals, and how they can be supported (water, soil, food, care)."
      },
      {
       "id": "5.4.6",
       "text": "Identifies the needs of people in different situations – in terms of access to resources, equal opportunities, work distribution, and shelter."
      },
      {
       "id": "5.4.7",
       "text": "Learns about basic social and behavioural norms, values, and dispositions that benefit our social and natural environments and that help our society function smoothly (using dustbins, standing in queues, conserving water, using public transportation, keeping one’s environment clean, always helping others in need regardless of background)."
      }
     ]
    },
    {
     "id": "5.5",
     "title": "Develops the ability to read and interpret simple maps.",
     "items": [
      {
       "id": "5.5.1",
       "text": "Explains a line drawing of their school, village, and ward."
      },
      {
       "id": "5.5.2",
       "text": "Draws a sketch of their school, village, and ward using symbols and directions."
      },
      {
       "id": "5.5.3",
       "text": "Reads simple maps of city, state, and country to identify natural and humanmade features (well, lake, post office, school, hospital) with reference to symbols and directions."
      }
     ]
    },
    {
     "id": "5.6",
     "title": "Uses data and information from various sources to investigate questions related to their immediate environment.",
     "items": [
      {
       "id": "5.6.1",
       "text": "Performs simple inquiry related to specific questions independently or in groups."
      },
      {
       "id": "5.6.2",
       "text": "Presents observations and findings through different creative modes (drawing, diagram, poem, play, skit, oral and written expression)."
      }
     ]
    },
    {
     "id": "5.7",
     "title": "Gains foundational familiarity with basic concepts and methods from the natural sciences (life sciences, physical sciences, and earth and space).",
     "items": [
      {
       "id": "5.7.1",
       "text": "Gains familiarity with using the scientific method in investigations, as well as familiarity with other crosscutting concepts such as energy, matter, and systems that apply across the domains of science and engineering."
      },
      {
       "id": "5.7.2",
       "text": "Gains familiarity with disciplinary core ideas in the natural sciences, as well as in engineering, technology, and applications of science, which reflect the content that will be learned across subject areas in later Grades."
      }
     ]
    }
   ]
  },
  {
   "kind": "SUBJECT",
   "id": "6",
   "title": "ARTS EDUCATION",
   "groups": [
    {
     "id": "6.1",
     "title": "Develops an enjoyment of the Arts and exercises their creativity and imagination in Visual and Performing Arts activities.",
     "items": [
      {
       "id": "6.1.1",
       "text": "Creates and presents a variety of artwork to communicate their ideas and emotions in any of the Visual and Performing Art forms (emphasis on variety in Music, painting, drawing, crafts, Drama, Dance and Movement, and local Art forms)."
      },
      {
       "id": "6.1.2",
       "text": "Describes the varied materials, tools, and processes used in the Visual and Performing Arts and demonstrates familiarity with some of these in their own artwork [e.g., identifies and names some musical instruments and demonstrates simple beats on a dholak, khanjira, bells, utensils, or one’s own body (clapping, tapping, making different sounds using mouth and hands)]."
      },
      {
       "id": "6.1.3",
       "text": "Creates artworks collaboratively and shares own thoughts and feelings while responding to arts and culture in their surroundings."
      }
     ]
    }
   ]
  },
  {
   "kind": "SUBJECT",
   "id": "7",
   "title": "PHYSICAL EDUCATION",
   "groups": [
    {
     "id": "7.1",
     "title": "Demonstrates the use of basic skills (running, jumping, catching, throwing, hitting, and kicking) to participate in different physical activities/games/sports.",
     "items": [
      {
       "id": "7.1.1",
       "text": "Practices a combination of movement, motor skills, and manipulative skills (catching, throwing, kicking, hitting a ball towards a target while moving, focusing on visual cues to hit the target)."
      },
      {
       "id": "7.1.2",
       "text": "Moves purposefully their body to a beat/rhythm/music."
      },
      {
       "id": "7.1.3",
       "text": "Demonstrates coordination abilities with a partner and objects (e.g., being able to move in coordination with a partner in three-legged race, hand-eye coordination while bowling, throwing)."
      },
      {
       "id": "7.1.4",
       "text": "Demonstrates basic warm-up exercises and stretching to develop strength and flexibility in the body."
      }
     ]
    },
    {
     "id": "7.2",
     "title": "Develops an awareness of their personal and social behaviour towards themselves and others.",
     "items": [
      {
       "id": "7.2.1",
       "text": "Demonstrates the ability to play games and activities which require and emphasise teamwork, cooperation, personal responsibility, and communication of ideas."
      },
      {
       "id": "7.2.2",
       "text": "Creates group norms and rules of the game/activity before playing and reviews these regularly."
      },
      {
       "id": "7.2.3",
       "text": "Exhibits sensitivity to injuries of others and acts empathetically when the other player is physically injured, emotionally stressed, and feeling unwell."
      },
      {
       "id": "7.2.4",
       "text": "Practices care and responsibility towards the physical activity material, playground, and facilities."
      },
      {
       "id": "7.2.5",
       "text": "Identifies characteristics of safe/unsafe touch in the context of physical activity and describes ways of reporting them."
      }
     ]
    },
    {
     "id": "7.3",
     "title": "Demonstrates mental engagement in physical activity/game situations.",
     "items": [
      {
       "id": "7.3.1",
       "text": "Explains the concept of some games, their rules, playing positions, and basic moves."
      },
      {
       "id": "7.3.2",
       "text": "Expresses their emotions and thinking process during the game."
      }
     ]
    },
    {
     "id": "7.4",
     "title": "Develops an understanding of the need to develop themselves and self-assess their progress.",
     "items": [
      {
       "id": "7.4.1",
       "text": "Sets simple personal goals/targets and records progress (e.g., throwing a ball at 25 m, then 30 m, then 40 m; Jumping 1, 2, 3 feet high/long)."
      }
     ]
    }
   ]
  },
  {
   "kind": "YESNO",
   "id": "8",
   "title": "SOCIO-EMOTIONAL-ETHICAL LEARNING",
   "items": [
    {
     "id": "8.0.1",
     "text": "Has emotional regulation and is able to respond appropriately to various situations."
    },
    {
     "id": "8.0.2",
     "text": "Displays empathy for all living beings and the environment."
    },
    {
     "id": "8.0.3",
     "text": "Is inclusive and kind in approach towards all cultural, social, religious and ethnic identities."
    },
    {
     "id": "8.0.4",
     "text": "Has resilience and displays grit."
    },
    {
     "id": "8.0.5",
     "text": "Understands ethical implications in all situations."
    }
   ]
  },
  {
   "kind": "YESNO",
   "id": "9",
   "title": "POSITIVE LEARNING HABITS",
   "items": [
    {
     "id": "9.0.1",
     "text": "Has the mental flexibility to sustain as well as shift attention appropriately."
    },
    {
     "id": "9.0.2",
     "text": "Asks interesting and relevant questions."
    },
    {
     "id": "9.0.3",
     "text": "Can articulate one’s opinions in a coherent and focused manner."
    },
    {
     "id": "9.0.4",
     "text": "Has growth mindset-seeks help actively."
    },
    {
     "id": "9.0.5",
     "text": "Is able to reflect on work done and take suitable action."
    },
    {
     "id": "9.0.6",
     "text": "Follows classroom norms with agency and understanding."
    },
    {
     "id": "9.0.7",
     "text": "Has self-control that enables learning in structured."
    }
   ]
  },
  {
   "kind": "CHOICE",
   "id": "10",
   "tag": "Part C",
   "title": "Peer Feedback",
   "scale": [
    "Cannot Say",
    "No",
    "Yes"
   ],
   "items": [
    {
     "id": "10.0.1",
     "text": "My friend can talk about how he/she feels, e.g. happy, confident, upset or angry."
    },
    {
     "id": "10.0.2",
     "text": "My friend can calm himself/herself down during difficult situations."
    },
    {
     "id": "10.0.3",
     "text": "My friend can understand how his/her friends feel."
    },
    {
     "id": "10.0.4",
     "text": "My friend respects everyone’s opinions."
    },
    {
     "id": "10.0.5",
     "text": "My friend can help others make up after a fight."
    },
    {
     "id": "10.0.6",
     "text": "When someone is sad, my friend can make them feel better."
    }
   ]
  },
  {
   "kind": "TEXT",
   "id": "11",
   "title": "Learner Feedback",
   "items": [
    {
     "id": "11.0.1",
     "text": "What am I good at?"
    },
    {
     "id": "11.0.2",
     "text": "What did I enjoy this term?"
    },
    {
     "id": "11.0.3",
     "text": "What did I find challenging?"
    },
    {
     "id": "11.0.4",
     "text": "What is my action plan for the next term?"
    }
   ]
  }
 ]
};

export const HPC_TEMPLATES: Record<string, HpcTemplate> = {
  BV1: {
 "stage": "BALVATIKA",
 "favourites": [],
 "glimpses": [],
 "parts": [
  {
   "kind": "STARS",
   "id": "1",
   "tag": "DEVELOPMENTAL GOAL 1 : HEALTH & WELL-BEING",
   "groups": [
    {
     "id": "1.1",
     "title": "HEALTH & HYGIENE",
     "items": [
      {
       "id": "1.1.1",
       "text": "Communicates immediate needs and follows hygiene & sanitation practices"
      },
      {
       "id": "1.1.2",
       "text": "Avoids wastage of food"
      },
      {
       "id": "1.1.3",
       "text": "Understands importance of food & water as a source of energy for work & play"
      }
     ]
    },
    {
     "id": "1.2",
     "title": "EMOTIONAL & SOCIAL DEVELOPMENT",
     "items": [
      {
       "id": "1.2.1",
       "text": "Identifies close family members, friends & neighbours"
      },
      {
       "id": "1.2.2",
       "text": "Participates in activities & takes initiatives"
      },
      {
       "id": "1.2.3",
       "text": "Waits for his/her turn & follows instructions"
      },
      {
       "id": "1.2.4",
       "text": "Chooses an activity area & gets engaged in the activity"
      },
      {
       "id": "1.2.5",
       "text": "Identifies feelings/wants/emotions"
      },
      {
       "id": "1.2.6",
       "text": "Makes choices and expresses preferences"
      },
      {
       "id": "1.2.7",
       "text": "Expresses joy while working and playing with other children"
      },
      {
       "id": "1.2.8",
       "text": "Helps other children, cares & shares belongings with them"
      },
      {
       "id": "1.2.9",
       "text": "Maintains distance from strangers and is aware about good touch and bad touch"
      },
      {
       "id": "1.2.10",
       "text": "Recognizes common dangers / hazards and takes safety precautions"
      }
     ]
    },
    {
     "id": "1.3",
     "title": "FINE MOTOR & AESTHETIC DEVELOPMENT",
     "items": [
      {
       "id": "1.3.1",
       "text": "Exhibits fine motor skills to perform more complex eye-hand coordination tasks"
      },
      {
       "id": "1.3.2",
       "text": "Uses coordinated movements to tear, roll, crumple paper"
      },
      {
       "id": "1.3.3",
       "text": "Uses coordinated movements for stringing the beads, lacing, pouring, sorting"
      },
      {
       "id": "1.3.4",
       "text": "Can hold pencil/crayon correctly"
      }
     ]
    },
    {
     "id": "1.4",
     "title": "GROSS MOTOR & PHYSICAL DEVELOPMENT",
     "items": [
      {
       "id": "1.4.1",
       "text": "Displays gross motor coordination & control in play activities-walking, running.."
      },
      {
       "id": "1.4.2",
       "text": "Demonstrates coordination to walk in/on straight/curved line"
      },
      {
       "id": "1.4.3",
       "text": "Displays coordination in catching/throwing/kicking a ball"
      },
      {
       "id": "1.4.4",
       "text": "Uses coordinated movement for jumping & hopping"
      },
      {
       "id": "1.4.5",
       "text": "Displays coordination in climbing up & down"
      }
     ]
    }
   ]
  },
  {
   "kind": "STARS",
   "id": "2",
   "tag": "DEVELOPMENTAL GOAL 2 : EFFECTIVE COMMUNICATION",
   "groups": [
    {
     "id": "2.1",
     "title": "LISTENING SKILLS",
     "items": [
      {
       "id": "2.1.1",
       "text": "Attempts to engage in conversation in school with teachers, friends, staff"
      },
      {
       "id": "2.1.2",
       "text": "Listens attentively and repeats familiar words and their sounds"
      },
      {
       "id": "2.1.3",
       "text": "Identifies various familiar sounds in the surrounding like birds chirping, rain fall"
      },
      {
       "id": "2.1.4",
       "text": "Makes various sounds/words for play like – sound of train, engine, bike"
      },
      {
       "id": "2.1.5",
       "text": "Has clarity of speech and can respond to direct questions"
      },
      {
       "id": "2.1.6",
       "text": "Uses own language to express needs & asks questions to gain information"
      }
     ]
    },
    {
     "id": "2.2",
     "title": "SPEAKING SKILLS",
     "items": [
      {
       "id": "2.2.1",
       "text": "Attempts to understand gestures, signs, expression while talking/interacting"
      },
      {
       "id": "2.2.2",
       "text": "Expresses fondness/liking for animals/birds in surrounding and talks about them"
      },
      {
       "id": "2.2.3",
       "text": "Talks about birds, animals, food, vegetable, etc. in surrounding"
      },
      {
       "id": "2.2.4",
       "text": "Collects objects from surrounding like twigs, leaves etc. and talk about them"
      }
     ]
    },
    {
     "id": "2.3",
     "title": "READING / WRITING SKILLS",
     "items": [
      {
       "id": "2.3.1",
       "text": "Spends time in reading area / play area"
      },
      {
       "id": "2.3.2",
       "text": "Attempts to write by drawing lines, scribbling with crayons"
      }
     ]
    },
    {
     "id": "2.4",
     "title": "STORY-TELLING",
     "items": [
      {
       "id": "2.4.1",
       "text": "Flips over pages of story books to make sense of it"
      },
      {
       "id": "2.4.2",
       "text": "Enjoys listening to stories bilingually and listens attentively"
      }
     ]
    }
   ]
  },
  {
   "kind": "STARS",
   "id": "3",
   "tag": "DEVELOPMENTAL GOAL 3 : INVOLVED LEARNERS",
   "groups": [
    {
     "id": "3.1",
     "title": "COGNITIVE SKILLS",
     "items": [
      {
       "id": "3.1.1",
       "text": "Describes common objects, sounds, people, pictures, events"
      },
      {
       "id": "3.1.2",
       "text": "Seriates/arranges 2-3 objects/picture cards in sequence like shape, size, events"
      },
      {
       "id": "3.1.3",
       "text": "Compares two objects based on one observable property-length, weight or size"
      },
      {
       "id": "3.1.4",
       "text": "Follows/reproduces pattern like clapping hands, clicking fingers, tapping feet etc."
      },
      {
       "id": "3.1.5",
       "text": "Participates actively in music, dance & creative movements like role-play etc."
      }
     ]
    }
   ]
  },
  {
   "kind": "STARS",
   "id": "4",
   "tag": "SCHOLASTIC ACTIVITIES",
   "groups": [
    {
     "id": "4.1",
     "title": "EVS",
     "items": [
      {
       "id": "4.1.1",
       "text": "Demonstrates awareness & sensitivity towards environmental concerns"
      },
      {
       "id": "4.1.2",
       "text": "Participates in environmental activities"
      },
      {
       "id": "4.1.3",
       "text": "Understands concepts"
      }
     ]
    },
    {
     "id": "4.2",
     "title": "ENGLISH",
     "items": [
      {
       "id": "4.2.1",
       "text": "Introduces himself/herself bilingually"
      },
      {
       "id": "4.2.2",
       "text": "Pronounces words correctly & speaks fluently"
      },
      {
       "id": "4.2.3",
       "text": "Uses good vocabulary"
      },
      {
       "id": "4.2.4",
       "text": "Recognises letters & corresponding sounds"
      },
      {
       "id": "4.2.5",
       "text": "Phonological awareness"
      },
      {
       "id": "4.2.6",
       "text": "Uses vocabulary in daily life like today, tomorrow, yesterday"
      },
      {
       "id": "4.2.7",
       "text": "Associates pictures with letters"
      },
      {
       "id": "4.2.8",
       "text": "Completes tasks independently"
      },
      {
       "id": "4.2.9",
       "text": "Demonstrates understanding of Opposite words and uses them appropriately"
      }
     ]
    },
    {
     "id": "4.3",
     "title": "HINDI",
     "items": [
      {
       "id": "4.3.1",
       "text": "Pronounces words correctly & speaks fluently"
      },
      {
       "id": "4.3.2",
       "text": "Uses good vocabulary"
      },
      {
       "id": "4.3.3",
       "text": "Recognises letters"
      },
      {
       "id": "4.3.4",
       "text": "Associates pictures with letters"
      },
      {
       "id": "4.3.5",
       "text": "Matches letters with pictures"
      },
      {
       "id": "4.3.6",
       "text": "Says Swar in sequence"
      }
     ]
    },
    {
     "id": "4.4",
     "title": "NUMBER SENSE & NUMBER OPERATIONS",
     "items": [
      {
       "id": "4.4.1",
       "text": "Counts numbers up to 10 / 20"
      },
      {
       "id": "4.4.2",
       "text": "Recognises number in sequence / random"
      },
      {
       "id": "4.4.3",
       "text": "Writes numerals with correct formation"
      },
      {
       "id": "4.4.4",
       "text": "Recognises number names - One to Five by poems/stories"
      },
      {
       "id": "4.4.5",
       "text": "Identifies basic shapes like ball, shoe-box, birthday cap, ice-cream cone"
      },
      {
       "id": "4.4.6",
       "text": "Identifies/counts objects like own body parts-two hands, one nose etc."
      },
      {
       "id": "4.4.7",
       "text": "Counts objects up to 10, concretely & pictorially"
      },
      {
       "id": "4.4.8",
       "text": "Understands pre-number concepts"
      },
      {
       "id": "4.4.9",
       "text": "Recites the names of days of the week & months of the year"
      }
     ]
    }
   ]
  },
  {
   "kind": "STARS",
   "id": "5",
   "tag": "NON-SCHOLASTIC ACTIVITIES",
   "groups": [
    {
     "id": "5.1",
     "title": "MUSIC",
     "items": [
      {
       "id": "5.1.1",
       "text": "Explores and participates in music, dance and creative movements"
      },
      {
       "id": "5.1.2",
       "text": "Sings/hums rhyming words/sentences from familiar poems/stories"
      },
      {
       "id": "5.1.3",
       "text": "Participates in singing poems/rhymes/songs"
      }
     ]
    },
    {
     "id": "5.2",
     "title": "ART & CRAFT",
     "items": [
      {
       "id": "5.2.1",
       "text": "Identifies Primary colours"
      },
      {
       "id": "5.2.2",
       "text": "Draws simple pictures and colours within defined space"
      }
     ]
    }
   ]
  }
 ]
},
  BV2: {
 "stage": "BALVATIKA",
 "favourites": [],
 "glimpses": [],
 "parts": [
  {
   "kind": "STARS",
   "id": "1",
   "tag": "DEVELOPMENTAL GOAL 1 : HEALTH & WELL-BEING",
   "groups": [
    {
     "id": "1.1",
     "title": "HEALTH & HYGIENE",
     "items": [
      {
       "id": "1.1.1",
       "text": "Communicates immediate needs and follows hygiene & sanitation practices"
      },
      {
       "id": "1.1.2",
       "text": "Demonstrates healthy eating practices with adult guidance"
      },
      {
       "id": "1.1.3",
       "text": "Avoids wastage of food"
      },
      {
       "id": "1.1.4",
       "text": "Understands importance of food & water as a source of energy for work & play"
      }
     ]
    },
    {
     "id": "1.2",
     "title": "EMOTIONAL & SOCIAL DEVELOPMENT",
     "items": [
      {
       "id": "1.2.1",
       "text": "Describes self in terms of physical characteristics"
      },
      {
       "id": "1.2.2",
       "text": "Identifies close family members, friends & neighbours"
      },
      {
       "id": "1.2.3",
       "text": "Expresses own preferences / interests and makes choices"
      },
      {
       "id": "1.2.4",
       "text": "Waits for his/her turn & follows instructions"
      },
      {
       "id": "1.2.5",
       "text": "Makes adjustments in the classroom & with other children"
      },
      {
       "id": "1.2.6",
       "text": "Plays cooperatively with other children and plans what and how they will play"
      },
      {
       "id": "1.2.7",
       "text": "Shows caring behaviour & shares belongings with other children"
      },
      {
       "id": "1.2.8",
       "text": "Demonstrates sensitivity/acceptability towards children of special needs"
      },
      {
       "id": "1.2.9",
       "text": "Demonstrates awareness about good touch and bad touch"
      },
      {
       "id": "1.2.10",
       "text": "Recognizes common dangers / hazards and takes safety precautions"
      }
     ]
    },
    {
     "id": "1.3",
     "title": "FINE MOTOR & AESTHETIC DEVELOPMENT",
     "items": [
      {
       "id": "1.3.1",
       "text": "Exhibits fine motor skills to perform more complex eye-hand coordination tasks"
      },
      {
       "id": "1.3.2",
       "text": "Uses coordinated movements for tearing, pasting, paper-folding"
      },
      {
       "id": "1.3.3",
       "text": "Uses coordinated movements for stringing the beads, lacing, pouring, sorting"
      },
      {
       "id": "1.3.4",
       "text": "Recognises different body parts & uses various body movements"
      },
      {
       "id": "1.3.5",
       "text": "Remembers & recalls objects seen at a time"
      }
     ]
    },
    {
     "id": "1.4",
     "title": "GROSS MOTOR & PHYSICAL DEVELOPMENT",
     "items": [
      {
       "id": "1.4.1",
       "text": "Displays gross motor coordination & control in play activities-walking, running.."
      },
      {
       "id": "1.4.2",
       "text": "Takes part in exercise, play & movements for fun and exercise"
      },
      {
       "id": "1.4.3",
       "text": "Walks up & down staircase while holding object"
      },
      {
       "id": "1.4.4",
       "text": "Displays coordination in bouncing/dribbling a ball"
      }
     ]
    }
   ]
  },
  {
   "kind": "STARS",
   "id": "2",
   "tag": "DEVELOPMENTAL GOAL 2 : EFFECTIVE COMMUNICATION",
   "groups": [
    {
     "id": "2.1",
     "title": "LISTENING SKILLS",
     "items": [
      {
       "id": "2.1.1",
       "text": "Attempts to engage in conversation in school with teachers, friends, staff"
      },
      {
       "id": "2.1.2",
       "text": "Listens attentively without interruption"
      },
      {
       "id": "2.1.3",
       "text": "Comprehends instructions"
      },
      {
       "id": "2.1.4",
       "text": "Attends, participates and listens to others during conversation"
      },
      {
       "id": "2.1.5",
       "text": "Recognises body language & facial expressions"
      },
      {
       "id": "2.1.6",
       "text": "Enjoys watching age-appropriate cartoon films"
      },
      {
       "id": "2.1.7",
       "text": "Understands tone of voice"
      }
     ]
    },
    {
     "id": "2.2",
     "title": "SPEAKING SKILLS",
     "items": [
      {
       "id": "2.2.1",
       "text": "Attempts to understand gestures, signs, expression while talking/interacting"
      },
      {
       "id": "2.2.2",
       "text": "Has clarity of speech and can respond to direct questions"
      },
      {
       "id": "2.2.3",
       "text": "Talks about birds, animals, food, vegetable, favourite toy etc."
      },
      {
       "id": "2.2.4",
       "text": "Collects objects from surrounding like twigs, leaves etc. and talk about them"
      },
      {
       "id": "2.2.5",
       "text": "Uses own language to express needs & asks questions to gain information"
      },
      {
       "id": "2.2.6",
       "text": "Has adequate vocabulary & can express ideas clearly"
      }
     ]
    },
    {
     "id": "2.3",
     "title": "READING / WRITING SKILLS",
     "items": [
      {
       "id": "2.3.1",
       "text": "Exhibits skills of early literary and print awareness eg. reading wrapper of biscuit"
      },
      {
       "id": "2.3.2",
       "text": "Spends time in reading area / play area"
      },
      {
       "id": "2.3.3",
       "text": "Identifies own name in writing"
      },
      {
       "id": "2.3.4",
       "text": "Attempts to write by drawing lines, scribbling with crayons"
      }
     ]
    },
    {
     "id": "2.4",
     "title": "STORY-TELLING",
     "items": [
      {
       "id": "2.4.1",
       "text": "Gives favourite story book to teacher to narrate the story"
      },
      {
       "id": "2.4.2",
       "text": "Expresses experience of reading stories in own language and shares with friends"
      },
      {
       "id": "2.4.3",
       "text": "Flips over pages of story books and attempts to read on own"
      },
      {
       "id": "2.4.4",
       "text": "Predicts story with the help of pictures"
      },
      {
       "id": "2.4.5",
       "text": "Reads the story by arranging the pictures in the sequence of events"
      },
      {
       "id": "2.4.6",
       "text": "Appreciates a story"
      }
     ]
    }
   ]
  },
  {
   "kind": "STARS",
   "id": "3",
   "tag": "DEVELOPMENTAL GOAL 3 : INVOLVED LEARNERS",
   "groups": [
    {
     "id": "3.1",
     "title": "COGNITIVE SKILLS",
     "items": [
      {
       "id": "3.1.1",
       "text": "Uses 05 senses to observe & explore the environment"
      },
      {
       "id": "3.1.2",
       "text": "Identifies 3-4 missing parts of a picture"
      },
      {
       "id": "3.1.3",
       "text": "Describes objects using size words like big/small, tall/short"
      },
      {
       "id": "3.1.4",
       "text": "Seriates/arranges 3-4 objects/picture cards in sequence like shape, size, events"
      },
      {
       "id": "3.1.5",
       "text": "Identifies the unit of repeating a simple pattern & extends the pattern"
      },
      {
       "id": "3.1.6",
       "text": "Observes & creates patterns of shapes"
      },
      {
       "id": "3.1.7",
       "text": "Follows/reproduces pattern like clapping hands, clicking fingers, tapping feet etc."
      }
     ]
    }
   ]
  },
  {
   "kind": "STARS",
   "id": "4",
   "tag": "SCHOLASTIC ACTIVITIES",
   "groups": [
    {
     "id": "4.1",
     "title": "EVS",
     "items": [
      {
       "id": "4.1.1",
       "text": "Demonstrates awareness & sensitivity towards environmental concerns"
      },
      {
       "id": "4.1.2",
       "text": "Participates in environmental activities"
      },
      {
       "id": "4.1.3",
       "text": "Identifies Plants, it’s parts & types"
      },
      {
       "id": "4.1.4",
       "text": "Demonstrates understanding of Weather & Seasons"
      },
      {
       "id": "4.1.5",
       "text": "Identifies Animals, Birds & Insects"
      },
      {
       "id": "4.1.6",
       "text": "Understands Modes of Tansport"
      },
      {
       "id": "4.1.7",
       "text": "Comprehends Community Helpers & Community Living"
      },
      {
       "id": "4.1.8",
       "text": "Demonstrates understanding of Traffic Light & Road Safety"
      }
     ]
    },
    {
     "id": "4.2",
     "title": "ENGLISH",
     "items": [
      {
       "id": "4.2.1",
       "text": "Recognises letters & corresponding sounds"
      },
      {
       "id": "4.2.2",
       "text": "Phonological awareness"
      },
      {
       "id": "4.2.3",
       "text": "Associates pictures with letters"
      },
      {
       "id": "4.2.4",
       "text": "Writes letters with correct formation & spacing"
      },
      {
       "id": "4.2.5",
       "text": "Reads sight words, familiar signs & simple sentences"
      },
      {
       "id": "4.2.6",
       "text": "Correctly uses position words like on, in, over, under etc. to describe objects"
      },
      {
       "id": "4.2.7",
       "text": "Completes tasks independently"
      },
      {
       "id": "4.2.8",
       "text": "Demonstrates understanding of Commands like - open, close, take, give"
      },
      {
       "id": "4.2.9",
       "text": "Recognises & uses Opposite words appropriately"
      },
      {
       "id": "4.2.10",
       "text": "Comprehends Vowels & Consonants"
      },
      {
       "id": "4.2.11",
       "text": "Recognises & uses beginning & ending sound words appropriately"
      },
      {
       "id": "4.2.12",
       "text": "Understands, reads & writes 3-Letter Words"
      },
      {
       "id": "4.2.13",
       "text": "Dictation"
      },
      {
       "id": "4.2.14",
       "text": "Picture Comprehension"
      },
      {
       "id": "4.2.15",
       "text": "Handwriting"
      }
     ]
    },
    {
     "id": "4.3",
     "title": "HINDI",
     "items": [
      {
       "id": "4.3.1",
       "text": "Reads Varnmala"
      },
      {
       "id": "4.3.2",
       "text": "Associates Varnmala to Pictures"
      },
      {
       "id": "4.3.3",
       "text": "Writes letters with correct formation"
      },
      {
       "id": "4.3.4",
       "text": "Says & writes Swar in sequence"
      },
      {
       "id": "4.3.5",
       "text": "Recognises & reads Vyanjan"
      },
      {
       "id": "4.3.6",
       "text": "Oral drill of numbers 1 to 10"
      }
     ]
    },
    {
     "id": "4.4",
     "title": "NUMBER SENSE & NUMBER OPERATIONS",
     "items": [
      {
       "id": "4.4.1",
       "text": "Recognises number in sequence 1 to 50"
      },
      {
       "id": "4.4.2",
       "text": "Recognises number in random 1 to 50"
      },
      {
       "id": "4.4.3",
       "text": "Writes numerals with correct formation"
      },
      {
       "id": "4.4.4",
       "text": "Writes number names - One to Five"
      },
      {
       "id": "4.4.5",
       "text": "Counts forward 0 to 50 backward 50 to 0"
      },
      {
       "id": "4.4.6",
       "text": "Understands Addition/Subtraction by 01 with objects/pictures"
      },
      {
       "id": "4.4.7",
       "text": "Counts objects up to 50, concretely & pictorially"
      },
      {
       "id": "4.4.8",
       "text": "Understands pre-number concepts"
      },
      {
       "id": "4.4.9",
       "text": "Compares two numbers up to 10 and uses vocabulary like more than, less than"
      },
      {
       "id": "4.4.10",
       "text": "Compares objects in length as longer than, shorter than, taller than"
      },
      {
       "id": "4.4.11",
       "text": "Uses vocabulary to express weight & capacities"
      },
      {
       "id": "4.4.12",
       "text": "Identifies Indian Currency coins"
      },
      {
       "id": "4.4.13",
       "text": "Recites the names of days of the week & months of the year"
      }
     ]
    }
   ]
  },
  {
   "kind": "STARS",
   "id": "5",
   "tag": "NON-SCHOLASTIC ACTIVITIES",
   "groups": [
    {
     "id": "5.1",
     "title": "MUSIC",
     "items": [
      {
       "id": "5.1.1",
       "text": "Explores and participates in music, dance and creative movements"
      },
      {
       "id": "5.1.2",
       "text": "Participates in rhythmic activity"
      },
      {
       "id": "5.1.3",
       "text": "Sings poems & rhymes with expression, rhythm & action"
      },
      {
       "id": "5.1.4",
       "text": "Uses appropriate intonation & modulation of voice while reciting poems/songs"
      }
     ]
    },
    {
     "id": "5.2",
     "title": "ART & CRAFT",
     "items": [
      {
       "id": "5.2.1",
       "text": "Draws pictures depicting some event/situation"
      },
      {
       "id": "5.2.2",
       "text": "Engages in art integrated activities, drawing, colouring, collage making, etc."
      },
      {
       "id": "5.2.3",
       "text": "Identifies Primary colours"
      },
      {
       "id": "5.2.4",
       "text": "Colours within defined space"
      },
      {
       "id": "5.2.5",
       "text": "Draws simple pictures"
      }
     ]
    }
   ]
  }
 ]
},
  BV3: {
 "stage": "BALVATIKA",
 "favourites": [],
 "glimpses": [],
 "parts": [
  {
   "kind": "STARS",
   "id": "1",
   "tag": "DEVELOPMENTAL GOAL 1 : HEALTH & WELL-BEING",
   "groups": [
    {
     "id": "1.1",
     "title": "HEALTH & HYGIENE",
     "items": [
      {
       "id": "1.1.1",
       "text": "Maintains hygiene & cleanliness with increased independence"
      },
      {
       "id": "1.1.2",
       "text": "Maintains healthy eating & sanitation practices with increased independence"
      },
      {
       "id": "1.1.3",
       "text": "Avoids wastage of food"
      },
      {
       "id": "1.1.4",
       "text": "Understands importance of food & water as a source of energy for work & play"
      }
     ]
    },
    {
     "id": "1.2",
     "title": "EMOTIONAL & SOCIAL DEVELOPMENT",
     "items": [
      {
       "id": "1.2.1",
       "text": "Follows directions, instructions & simple rules at the same time"
      },
      {
       "id": "1.2.2",
       "text": "Uses appropriate manners & shares play and learning material"
      },
      {
       "id": "1.2.3",
       "text": "Shows adaptability to any changes in routine & makes adjustment"
      },
      {
       "id": "1.2.4",
       "text": "Identifies one’s own feeling & expresses emotions in socially approved ways"
      },
      {
       "id": "1.2.5",
       "text": "Takes responsibility and makes choices based on own preferences and interests"
      },
      {
       "id": "1.2.6",
       "text": "Focusses attention; chooses & completes an activity started independently"
      },
      {
       "id": "1.2.7",
       "text": "Has good rapport with peers & shows cooperation in group activities"
      },
      {
       "id": "1.2.8",
       "text": "Demonstrates willingness to include other’s ideas during interaction & play"
      },
      {
       "id": "1.2.9",
       "text": "Expresses emotions through verbal & non-verbal modes"
      },
      {
       "id": "1.2.10",
       "text": "Shows sensitivity & acceptability to children from diverse backgrounds/special needs"
      },
      {
       "id": "1.2.11",
       "text": "Follows basic rules of safety at home, school & playground"
      },
      {
       "id": "1.2.12",
       "text": "Demonstrates awareness of good / bad touch & maintains distance from strangers"
      }
     ]
    },
    {
     "id": "1.3",
     "title": "FINE MOTOR & AESTHETIC DEVELOPMENT",
     "items": [
      {
       "id": "1.3.1",
       "text": "Uses a pincer grip to hold & manipulate tools for drawing, painting & writing"
      },
      {
       "id": "1.3.2",
       "text": "Uses coordinated movements to complete complex tasks like cutting along a line, pouring"
      },
      {
       "id": "1.3.3",
       "text": "Describes physical characteristics, gender, interests, likes, dislikes of self & others"
      },
      {
       "id": "1.3.4",
       "text": "Exhibits fine motor skills with precision & control"
      },
      {
       "id": "1.3.5",
       "text": "Remembers & recalls objects seen at a time"
      }
     ]
    },
    {
     "id": "1.4",
     "title": "GROSS MOTOR & PHYSICAL DEVELOPMENT",
     "items": [
      {
       "id": "1.4.1",
       "text": "Displays strength, judgement & decision-making in gross motor skills"
      },
      {
       "id": "1.4.2",
       "text": "Demonstrates coordination, control & strength for running, jumping, kicking, throwing"
      },
      {
       "id": "1.4.3",
       "text": "Demonstrates independence in activities"
      },
      {
       "id": "1.4.4",
       "text": "Displays coordination in bouncing/dribbling a ball"
      },
      {
       "id": "1.4.5",
       "text": "Participates actively in music, dance & creative movements like role-play, dramatization"
      }
     ]
    }
   ]
  },
  {
   "kind": "STARS",
   "id": "2",
   "tag": "DEVELOPMENTAL GOAL 2 : EFFECTIVE COMMUNICATION",
   "groups": [
    {
     "id": "2.1",
     "title": "WRITING WITH PURPOSE",
     "items": [
      {
       "id": "2.1.1",
       "text": "Takes interest in writing own name, names of friends/objects"
      },
      {
       "id": "2.1.2",
       "text": "Attempts to scribble / write a few familiar words"
      },
      {
       "id": "2.1.3",
       "text": "Draws pictures to communicate messages"
      },
      {
       "id": "2.1.4",
       "text": "Observes objects and writes their name using invented spelling / conventional writing"
      }
     ]
    },
    {
     "id": "2.2",
     "title": "SPEAKING & LISTENING SKILLS",
     "items": [
      {
       "id": "2.2.1",
       "text": "Has clarity of speech & listens attentively without interruption"
      },
      {
       "id": "2.2.2",
       "text": "Comprehends instructions & responds appropriately"
      },
      {
       "id": "2.2.3",
       "text": "Attempts to respond using familiar words and expressions"
      },
      {
       "id": "2.2.4",
       "text": "Uses own language to express needs & asks questions to gain information"
      },
      {
       "id": "2.2.5",
       "text": "Shares feelings and talks about birds, animals, trees, food, vegetables, favourite toy"
      },
      {
       "id": "2.2.6",
       "text": "Recognises body language, facial expressions and tone of voice"
      },
      {
       "id": "2.2.7",
       "text": "Identifies repeated sounds in words occurring in familiar stories/poems/songs"
      },
      {
       "id": "2.2.8",
       "text": "Has adequate vocabulary & can express ideas clearly"
      },
      {
       "id": "2.2.9",
       "text": "Enjoys watching age-appropriate cartoon films"
      }
     ]
    },
    {
     "id": "2.3",
     "title": "READING WITH COMPREHENSION",
     "items": [
      {
       "id": "2.3.1",
       "text": "Gives favourite story book to teacher to narrate the story"
      },
      {
       "id": "2.3.2",
       "text": "Selects book to read and attempts to understand story with help of pictures"
      },
      {
       "id": "2.3.3",
       "text": "Predicts story with help of pictures, print, letter-sound association, previous experiences"
      },
      {
       "id": "2.3.4",
       "text": "Expresses experience of reading poems/stories in own language and shares with friends"
      },
      {
       "id": "2.3.5",
       "text": "Observes objects in pictures attentively and talks about them"
      },
      {
       "id": "2.3.6",
       "text": "Reads the story by understanding/arranging the pictures in the sequence of events"
      },
      {
       "id": "2.3.7",
       "text": "Connects personal experience & talks about it in own language"
      },
      {
       "id": "2.3.8",
       "text": "Attempts to sound words & respond using familiar words & expressions"
      }
     ]
    }
   ]
  },
  {
   "kind": "STARS",
   "id": "3",
   "tag": "DEVELOPMENTAL GOAL 3 : INVOLVED LEARNERS",
   "groups": [
    {
     "id": "3.1",
     "title": "COGNITIVE SKILLS",
     "items": [
      {
       "id": "3.1.1",
       "text": "Remembers and recalls 4-5 objects seen at a time"
      },
      {
       "id": "3.1.2",
       "text": "Identifies 3-5 missing parts of a picture of familiar object"
      },
      {
       "id": "3.1.3",
       "text": "Compares & classifies objects by three factors like shape, colour & size"
      },
      {
       "id": "3.1.4",
       "text": "Arranges 4-5 picture cards/objects in a sequence by shape, size, occurrence of events"
      },
      {
       "id": "3.1.5",
       "text": "Engages in investigating objects-asks questions, inquires, discovers"
      },
      {
       "id": "3.1.6",
       "text": "Draws inferences from situations like - I have more red pencils than blue"
      },
      {
       "id": "3.1.7",
       "text": "Identifies the unit of repeating a simple pattern & extends the pattern"
      },
      {
       "id": "3.1.8",
       "text": "When narrated a story can understand time-related events"
      }
     ]
    }
   ]
  },
  {
   "kind": "STARS",
   "id": "4",
   "tag": "SCHOLASTIC ACTIVITIES",
   "groups": [
    {
     "id": "4.1",
     "title": "EVS",
     "items": [
      {
       "id": "4.1.1",
       "text": "Demonstrates awareness & sensitivity towards environmental concerns"
      },
      {
       "id": "4.1.2",
       "text": "Understands concept of Myself, Family, Parts of body & Senses"
      },
      {
       "id": "4.1.3",
       "text": "Demonstrates understanding of Weather & Seasons"
      },
      {
       "id": "4.1.4",
       "text": "Identifies Plants, Trees, Flowers, Fruits - it’s types, parts & uses"
      },
      {
       "id": "4.1.5",
       "text": "Identifies Birds, Insects, Animals - it's Home & Young Ones"
      },
      {
       "id": "4.1.6",
       "text": "Understands Modes of Transport, Road Safety, Traffic Light & Traffic Rules"
      },
      {
       "id": "4.1.7",
       "text": "Comprehends Community Helpers & Community Living"
      },
      {
       "id": "4.1.8",
       "text": "Understands Air & Water Sources - it's uses"
      },
      {
       "id": "4.1.9",
       "text": "Understands Living & Non-living Things"
      },
      {
       "id": "4.1.10",
       "text": "Understands National Symbols"
      }
     ]
    },
    {
     "id": "4.2",
     "title": "ENGLISH",
     "items": [
      {
       "id": "4.2.1",
       "text": "Recognises letters & corresponding sounds"
      },
      {
       "id": "4.2.2",
       "text": "Reads sight words, familiar signs & simple sentences"
      },
      {
       "id": "4.2.3",
       "text": "Reads with the understanding of print awareness and comprehends text correctly"
      },
      {
       "id": "4.2.4",
       "text": "Writes sentences with correct formation & spacing"
      },
      {
       "id": "4.2.5",
       "text": "Solves textual crossword & puzzle"
      },
      {
       "id": "4.2.6",
       "text": "Uses Question words appropriately (Why, Where, When, etc.)"
      },
      {
       "id": "4.2.7",
       "text": "Correctly uses position words like besides, under, over, inside to describe objects"
      },
      {
       "id": "4.2.8",
       "text": "Recognises & uses Articles appropriately"
      },
      {
       "id": "4.2.9",
       "text": "Demonstrates understanding of One & Many"
      },
      {
       "id": "4.2.10",
       "text": "Demonstrates understanding of Opposite words and uses them appropriately"
      },
      {
       "id": "4.2.11",
       "text": "Recognises & uses Action Words correctly"
      },
      {
       "id": "4.2.12",
       "text": "Uses This/That, These/Those, is/are appropriately"
      },
      {
       "id": "4.2.13",
       "text": "Demonstrates understanding of Blends – ch, oo, sh, etc."
      },
      {
       "id": "4.2.14",
       "text": "Dictation"
      },
      {
       "id": "4.2.15",
       "text": "Reading Comprehension"
      }
     ]
    },
    {
     "id": "4.3",
     "title": "HINDI",
     "items": [
      {
       "id": "4.3.1",
       "text": "Reads Varnmala"
      },
      {
       "id": "4.3.2",
       "text": "Says & writes Varnmala in sequence"
      },
      {
       "id": "4.3.3",
       "text": "Reads 02/03/04 letter words and comprehends text correctly"
      },
      {
       "id": "4.3.4",
       "text": "Solves exercises related to Varnmala"
      },
      {
       "id": "4.3.5",
       "text": "Demonstrates understanding & recognition of Matra"
      },
      {
       "id": "4.3.6",
       "text": "Numbers 1 to 10"
      },
      {
       "id": "4.3.7",
       "text": "Reading Comprehension"
      },
      {
       "id": "4.3.8",
       "text": "Dictation"
      },
      {
       "id": "4.3.9",
       "text": "Handwriting"
      }
     ]
    },
    {
     "id": "4.4",
     "title": "NUMBER SENSE & NUMBER OPERATIONS",
     "items": [
      {
       "id": "4.4.1",
       "text": "Recognises number in sequence & random"
      },
      {
       "id": "4.4.2",
       "text": "Writes numerals with correct formation"
      },
      {
       "id": "4.4.3",
       "text": "Writes number names - 1 to 20"
      },
      {
       "id": "4.4.4",
       "text": "Counts forward 0 to 100 backward 100 to 0"
      },
      {
       "id": "4.4.5",
       "text": "Demonstrates understanding of Tens & Ones"
      },
      {
       "id": "4.4.6",
       "text": "Demonstrates awareness that things reduce in number and become NIL"
      },
      {
       "id": "4.4.7",
       "text": "Understands concepts of Addition & Subtraction"
      },
      {
       "id": "4.4.8",
       "text": "Compares two numbers up to 20 and uses smaller than, greater than, equal to sign (>, <, =)"
      },
      {
       "id": "4.4.9",
       "text": "Compares objects in Length, Weight & Capacities in volume"
      },
      {
       "id": "4.4.10",
       "text": "Identifies Indian currency notes"
      },
      {
       "id": "4.4.11",
       "text": "Ordinal numbers"
      },
      {
       "id": "4.4.12",
       "text": "Recites the names of days of the week & months of the year"
      },
      {
       "id": "4.4.13",
       "text": "Reading the Clock"
      }
     ]
    }
   ]
  },
  {
   "kind": "STARS",
   "id": "5",
   "tag": "NON-SCHOLASTIC ACTIVITIES",
   "groups": [
    {
     "id": "5.1",
     "title": "MUSIC",
     "items": [
      {
       "id": "5.1.1",
       "text": "Recites rhymes with expression, rhythm & action"
      },
      {
       "id": "5.1.2",
       "text": "Uses appropriate intonation & modulation of voice while reciting poems/songs"
      },
      {
       "id": "5.1.3",
       "text": "Explores space & participates actively / creatively in music & movement activities"
      }
     ]
    },
    {
     "id": "5.2",
     "title": "ART & CRAFT",
     "items": [
      {
       "id": "5.2.1",
       "text": "Engages in art integrated activities, drawing, colouring, collage making, etc."
      },
      {
       "id": "5.2.2",
       "text": "Identifies primary & secondary colours"
      },
      {
       "id": "5.2.3",
       "text": "Draws simple pictures and colours within defined space"
      },
      {
       "id": "5.2.4",
       "text": "Creates new patterns with leaf printing or thumb printing"
      }
     ]
    }
   ]
  }
 ]
},
  I: {
 "stage": "FOUNDATIONAL",
 "favourites": [
  {
   "id": "f.1",
   "text": "Colour"
  },
  {
   "id": "f.2",
   "text": "Animal"
  },
  {
   "id": "f.3",
   "text": "Game"
  },
  {
   "id": "f.4",
   "text": "Vegetable"
  },
  {
   "id": "f.5",
   "text": "Food"
  },
  {
   "id": "f.6",
   "text": "Friends"
  }
 ],
 "glimpses": [
  "FAMILY",
  "SELF",
  "PORTFOLIO"
 ],
 "parts": [
  {
   "kind": "GOALS",
   "id": "1",
   "tag": "CURRICULUM GOALS",
   "groups": [
    {
     "id": "1.1",
     "title": "Develop habits that keep him/her safe and healthy",
     "items": [
      {
       "id": "1.1.1",
       "text": "Shows a liking for and understanding of nutritious food and does not waste them."
      },
      {
       "id": "1.1.2",
       "text": "Recognises different body parts and uses various body movements."
      },
      {
       "id": "1.1.3",
       "text": "Practices basic self-care and hygiene."
      },
      {
       "id": "1.1.4",
       "text": "Understands unsafe situations and asks for help."
      }
     ]
    },
    {
     "id": "1.2",
     "title": "Develops sharpness in sensorial perceptions.",
     "items": [
      {
       "id": "1.2.1",
       "text": "Displays fine motor skills with accuracy and control."
      },
      {
       "id": "1.2.2",
       "text": "Differentiates between shapes, colors and their shades."
      },
      {
       "id": "1.2.3",
       "text": "Develops discrimination in the sense of touch."
      },
      {
       "id": "1.2.4",
       "text": "Begins integrating sensorial, perceptions to get a holistic awareness of experiences."
      }
     ]
    },
    {
     "id": "1.3",
     "title": "Develops a fit and flexible body",
     "items": [
      {
       "id": "1.3.1",
       "text": "Shows balance, coordination and flexibility in various physical activities."
      },
      {
       "id": "1.3.2",
       "text": "Shows strength and endurance in carrying, walking and running."
      }
     ]
    },
    {
     "id": "1.4",
     "title": "Develops emotional intelligence",
     "items": [
      {
       "id": "1.4.1",
       "text": "Demonstrates care and respect for immediate and extended family and neighbour."
      },
      {
       "id": "1.4.2",
       "text": "Recognises different emotions and makes a deliberate effort to regulate them appropriately."
      },
      {
       "id": "1.4.3",
       "text": "Interacts comfortably with peers and adults."
      },
      {
       "id": "1.4.4",
       "text": "Shows kindness and helpfulness to others (including plants, animals) when they are in need."
      }
     ]
    },
    {
     "id": "1.5",
     "title": "Develops a positive attitude towards productive work and service or “SEVA”",
     "items": [
      {
       "id": "1.5.1",
       "text": "Demonstrates willingness and participates in age-appropriate physical work towards helping others."
      }
     ]
    },
    {
     "id": "1.6",
     "title": "Develops a positive regard for the natural environment around him/ her.",
     "items": [
      {
       "id": "1.6.1",
       "text": "Shows care for and joy in engaging with all life forms."
      },
      {
       "id": "1.6.2",
       "text": "Demonstrates awareness and sensitivity towards environmental concerns - planting flower plants, watering them regularly, saving water by planting trees, etc."
      }
     ]
    },
    {
     "id": "1.7",
     "title": "Makes sense of the world around through observation and logical thinking.",
     "items": [
      {
       "id": "1.7.1",
       "text": "Shows curiosity and interests in knowing new things."
      },
      {
       "id": "1.7.2",
       "text": "Observe and understand different categories of objects and the relationships between them."
      },
      {
       "id": "1.7.3",
       "text": "Observes cause and effect relationships in nature by forming simple hypothesis."
      }
     ]
    },
    {
     "id": "1.8",
     "title": "Develops mathematical understanding and ability to recognise the world through quantities, shapes and measures.",
     "items": [
      {
       "id": "1.8.1",
       "text": "Sorts objects into groups and sub-groups based on more than one property."
      },
      {
       "id": "1.8.2",
       "text": "Identifies and extends simple patterns in their surroundings, shapes and numbers."
      },
      {
       "id": "1.8.3",
       "text": "Identifies and uses numerals to represent quantities up to 99."
      },
      {
       "id": "1.8.4",
       "text": "Counts upto 99 both forwards and backwards and in groups of 10s and 20s."
      },
      {
       "id": "1.8.5",
       "text": "Performs addition and subtraction of one and two-digit numbers fluently."
      },
      {
       "id": "1.8.6",
       "text": "Recognises, makes and classifies basic geometric shapes and their observable properties."
      },
      {
       "id": "1.8.7",
       "text": "Formulates and solves simple mathematical problems related to quantities, shapes, space, and measurements."
      },
      {
       "id": "1.8.8",
       "text": "Develops the concept of zero."
      },
      {
       "id": "1.8.9",
       "text": "Represents an amount up to Rs.20 using notes/coins."
      },
      {
       "id": "1.8.10",
       "text": "Compares two numbers up to 20 and uses vocabulary like bigger than or smaller than."
      },
      {
       "id": "1.8.11",
       "text": "Estimates and measures short lengths using non uniform units like a finger, hand span, length of a forearm, foot span etc."
      },
      {
       "id": "1.8.12",
       "text": "Compares three objects in terms of their weight as heaviest/lightest."
      },
      {
       "id": "1.8.13",
       "text": "Identifies the relationship between half and whole using paper folding, daily life context."
      },
      {
       "id": "1.8.14",
       "text": "Seriates/ arranges more than 5 objects based on criteria."
      },
      {
       "id": "1.8.15",
       "text": "Describes his/her daily routine in sequence using words in the morning, afternoon, evening and night."
      }
     ]
    },
    {
     "id": "1.9",
     "title": "Develops fluency in reading and writing in Language I",
     "items": [
      {
       "id": "1.9.1",
       "text": "Recognises all the letters of the alphabets and uses this knowledge to read and write words."
      },
      {
       "id": "1.9.2",
       "text": "Reads stories and passages with accuracy and fluency with appropriate pauses and voice modulation."
      },
      {
       "id": "1.9.3",
       "text": "Reads short stories and comprehends their meaning – by identifying characters, storyline and what the author wanted to say – on their own."
      },
      {
       "id": "1.9.4",
       "text": "Responds orally to questions related to stories/poems."
      },
      {
       "id": "1.9.5",
       "text": "Reads and comprehends the meaning of short news items, instructions and publicity materials."
      },
      {
       "id": "1.9.6",
       "text": "Converses fluently and can hold a meaningful conversation."
      },
      {
       "id": "1.9.7",
       "text": "Forms letters correctly, uses sound-symbol correspondence to write invented spellings."
      },
      {
       "id": "1.9.8",
       "text": "Writes words beginning with the same letter in Language I"
      },
      {
       "id": "1.9.9",
       "text": "Identifies rhyming words in familiar poems and songs and creates rhyming words."
      },
      {
       "id": "1.9.10",
       "text": "Makes a card for their friend, sending a short message."
      }
     ]
    },
    {
     "id": "1.10",
     "title": "Begins to read and write Language II",
     "items": [
      {
       "id": "1.10.1",
       "text": "Recognises most frequently occurring letters of the alphabet of the script."
      },
      {
       "id": "1.10.2",
       "text": "Reads and writes simple words and sentences."
      },
      {
       "id": "1.10.3",
       "text": "Responds orally to the questions asked in the Language."
      },
      {
       "id": "1.10.4",
       "text": "Listens and appreciates simple songs, rhymes and poems."
      },
      {
       "id": "1.10.5",
       "text": "Picks the storybook from the reading area and tries to read the pictures."
      },
      {
       "id": "1.10.6",
       "text": "Writes words beginning with the same letter in Language II"
      }
     ]
    },
    {
     "id": "1.11",
     "title": "Develops abilities and sensibilities in visual and performing arts, and expresses their emotions through art in meaningful and joyful ways",
     "items": [
      {
       "id": "1.11.1",
       "text": "Explores and plays with various materials and tools to create two-dimensional and three-dimensional artworks in varying sizes."
      },
      {
       "id": "1.11.2",
       "text": "Explores and plays with own voice, body, spaces and various objects to create music, role-play, dance and movement."
      },
      {
       "id": "1.11.3",
       "text": "Innovates and works imaginatively to express ideas and emotions through the art."
      }
     ]
    },
    {
     "id": "1.12",
     "title": "Develops habit of learning that allow him/ her to engage actively in formal learning environments like school classroom.",
     "items": [
      {
       "id": "1.12.1",
       "text": "Shows curiosity and interest in exploring environment, takes interest in experimentation and exploration, draws inferences and predicting various senses."
      },
      {
       "id": "1.12.2",
       "text": "Acquires skills to plan, focus attention, and direct activities to achieve specific goals."
      }
     ]
    }
   ]
  },
  {
   "kind": "SMILEYS",
   "id": "2",
   "title": "Self Assessment",
   "groups": [
    {
     "id": "2.1",
     "title": "Activity that I enjoy doing with my friends",
     "items": [
      {
       "id": "2.1.1",
       "text": "Playing"
      },
      {
       "id": "2.1.2",
       "text": "Dancing"
      },
      {
       "id": "2.1.3",
       "text": "Studying"
      },
      {
       "id": "2.1.4",
       "text": "Jumping"
      },
      {
       "id": "2.1.5",
       "text": "Cleaning my classroom"
      },
      {
       "id": "2.1.6",
       "text": "Building blocks"
      }
     ]
    },
    {
     "id": "2.2",
     "title": "Activity that I find difficult",
     "items": [
      {
       "id": "2.2.1",
       "text": "Studying"
      },
      {
       "id": "2.2.2",
       "text": "Drawing"
      },
      {
       "id": "2.2.3",
       "text": "Colouring"
      },
      {
       "id": "2.2.4",
       "text": "Writing"
      },
      {
       "id": "2.2.5",
       "text": "Solving puzzles"
      },
      {
       "id": "2.2.6",
       "text": "Nothing"
      }
     ]
    },
    {
     "id": "2.3",
     "title": "Activity/ activities I enjoy the most",
     "items": [
      {
       "id": "2.3.1",
       "text": "Playing"
      },
      {
       "id": "2.3.2",
       "text": "Studying"
      },
      {
       "id": "2.3.3",
       "text": "Drawing"
      },
      {
       "id": "2.3.4",
       "text": "Colouring"
      },
      {
       "id": "2.3.5",
       "text": "Dancing"
      },
      {
       "id": "2.3.6",
       "text": "Swimming"
      },
      {
       "id": "2.3.7",
       "text": "Clay Modeling"
      },
      {
       "id": "2.3.8",
       "text": "Singing"
      },
      {
       "id": "2.3.9",
       "text": "Origami work"
      },
      {
       "id": "2.3.10",
       "text": "Quiz"
      },
      {
       "id": "2.3.11",
       "text": "Taking care of plants"
      }
     ]
    }
   ]
  },
  {
   "kind": "SMILEYS",
   "id": "3",
   "title": "Peer Assessment",
   "groups": [
    {
     "id": "3.1",
     "title": "Peer Assessment",
     "items": [
      {
       "id": "3.1.1",
       "text": "He/ She helps in completing tasks/activity."
      },
      {
       "id": "3.1.2",
       "text": "He/ She likes to play with others."
      },
      {
       "id": "3.1.3",
       "text": "He/ She shares stationery with classmates."
      }
     ]
    }
   ]
  }
 ]
},
  II: {
 "stage": "FOUNDATIONAL",
 "favourites": [
  {
   "id": "f.1",
   "text": "Colour"
  },
  {
   "id": "f.2",
   "text": "Animal"
  },
  {
   "id": "f.3",
   "text": "Game"
  },
  {
   "id": "f.4",
   "text": "Vegetable"
  },
  {
   "id": "f.5",
   "text": "Food"
  },
  {
   "id": "f.6",
   "text": "Friends"
  }
 ],
 "glimpses": [
  "FAMILY",
  "SELF",
  "PORTFOLIO"
 ],
 "parts": [
  {
   "kind": "GOALS",
   "id": "1",
   "tag": "CURRICULUM GOALS",
   "groups": [
    {
     "id": "1.1",
     "title": "Develop habits that keep him/her safe and healthy",
     "items": [
      {
       "id": "1.1.1",
       "text": "Demonstrates awareness and sensitivity towards self and environmental concerns like not wasting food or throwing waste in bin."
      },
      {
       "id": "1.1.2",
       "text": "Resolves minor conflicts independently or with the help of teacher or adults."
      },
      {
       "id": "1.1.3",
       "text": "Demonstrates proper use of toilet, cleanliness after toilet uses and exhibits cleanliness (self and environment), hygiene and healthy eating practices."
      },
      {
       "id": "1.1.4",
       "text": "Reports to the teacher(in school) and elders in the event of injury and/ or sickness."
      }
     ]
    },
    {
     "id": "1.2",
     "title": "Develops sharpness in sensorial perceptions.",
     "items": [
      {
       "id": "1.2.1",
       "text": "Demonstrate control and appropriate pressure when using writing and drawing tools."
      },
      {
       "id": "1.2.2",
       "text": "Demonstrates eye-hand and neuromuscular coordination and develops judgment and decision-making."
      },
      {
       "id": "1.2.3",
       "text": "Follows complex instructions/rules; Starts creating their own rules while differentiating between shapes, colours and their shades."
      }
     ]
    },
    {
     "id": "1.3",
     "title": "Develops a fit and flexible body",
     "items": [
      {
       "id": "1.3.1",
       "text": "Maintains correct posture, uses various body movements to participate in games and sports."
      },
      {
       "id": "1.3.2",
       "text": "Selects games/ play equipment according to their own choice, preference, and interest."
      }
     ]
    },
    {
     "id": "1.4",
     "title": "Develops emotional intelligence",
     "items": [
      {
       "id": "1.4.1",
       "text": "Demonstrates care and respect for immediate and extended family and neighbour."
      },
      {
       "id": "1.4.2",
       "text": "Copes with emotions appropriately in varied situations."
      },
      {
       "id": "1.4.3",
       "text": "Exhibits acceptance and tolerance towards differences among people and demonstrates sensitivity to diversity."
      }
     ]
    },
    {
     "id": "1.5",
     "title": "Develops a positive attitude towards productive work and service or “SEVA”",
     "items": [
      {
       "id": "1.5.1",
       "text": "Connects and contributes to the world around him/ her."
      }
     ]
    },
    {
     "id": "1.6",
     "title": "Develops a positive regard for the natural environment around him/ her.",
     "items": [
      {
       "id": "1.6.1",
       "text": "Shows curiosity and interest in experimentation and exploration and takes the initiative in drawing inferences and reasoning."
      },
      {
       "id": "1.6.2",
       "text": "Adjust to any changes in the environment and ask others to follow."
      }
     ]
    },
    {
     "id": "1.7",
     "title": "Makes sense of the world around through observation and logical thinking.",
     "items": [
      {
       "id": "1.7.1",
       "text": "Recognises familiar features in the immediate environment."
      },
      {
       "id": "1.7.2",
       "text": "States the cause of different happening in nature using the facts available."
      },
      {
       "id": "1.7.3",
       "text": "Forms differences between objects and the relationships between them."
      }
     ]
    },
    {
     "id": "1.8",
     "title": "Develops mathematical understanding and ability to recognise the world through quantities, shapes and measures.",
     "items": [
      {
       "id": "1.8.1",
       "text": "Applies seriation in ordering numbers, measurements etc."
      },
      {
       "id": "1.8.2",
       "text": "Sequences the events occurring according to their duration in terms of days."
      },
      {
       "id": "1.8.3",
       "text": "Counts objects up to 100 in a group of tens."
      },
      {
       "id": "1.8.4",
       "text": "Can count forward and backward from a particular number up to 99."
      },
      {
       "id": "1.8.5",
       "text": "Uses zero in place value system."
      },
      {
       "id": "1.8.6",
       "text": "Compares and forms the greatest and smallest two- digit numbers (with and without repetition of given digits)."
      },
      {
       "id": "1.8.7",
       "text": "Develops her/his strategies to add two numbers and applies them to solve simple daily life problems/ situations."
      },
      {
       "id": "1.8.8",
       "text": "Develops her/his strategies to subtract two numbers and applies them to solve simple daily life problems/ situations."
      },
      {
       "id": "1.8.9",
       "text": "Appreciates and applies relationship between addition and subtraction of numbers.."
      },
      {
       "id": "1.8.10",
       "text": "Develops the idea of multiplication of numbers and constructs and applies multiplication facts (tables) of 2, 3 and 4 in daily life situations."
      },
      {
       "id": "1.8.11",
       "text": "Develops the idea of division of numbers as equal distribution/ sharing."
      },
      {
       "id": "1.8.12",
       "text": "Identifies appropriate operation (addition or subtraction) to solve problems in a familiar situation/context."
      },
      {
       "id": "1.8.13",
       "text": "Represents an amount up to Rs.100 using notes and coins."
      },
      {
       "id": "1.8.14",
       "text": "Identifies and describes basic 2D shapes and other shapes around her/ him."
      },
      {
       "id": "1.8.15",
       "text": "Estimates and measures length/ distance using uniform non- standard units."
      },
      {
       "id": "1.8.16",
       "text": "Compares objects as heavier than/ lighter than using simple balance."
      },
      {
       "id": "1.8.17",
       "text": "Compares the capacity of different containers in terms of non-standard units."
      },
      {
       "id": "1.8.18",
       "text": "Identifies the relationship between half, quarter and whole using objects from the environment."
      },
      {
       "id": "1.8.19",
       "text": "Observes and generalises the patterns in numbers like in multiplication tables, 1- 100 number grid or objects in the environment."
      },
      {
       "id": "1.8.20",
       "text": "Draws inference based on the data collected."
      },
      {
       "id": "1.8.21",
       "text": "Identifies the days of the week and months of the year using a calendar in her daily life events."
      }
     ]
    },
    {
     "id": "1.9",
     "title": "Develops fluency in reading and writing in Language I",
     "items": [
      {
       "id": "1.9.1",
       "text": "Uses school language to express opinion, ask, question for different purposes."
      },
      {
       "id": "1.9.2",
       "text": "Talks about the characters from the familiar story. Draws the picture and write, the name of their favourite character."
      },
      {
       "id": "1.9.3",
       "text": "Narrates stories and recites poems in their own language using their own style/way."
      },
      {
       "id": "1.9.4",
       "text": "Participates in class/school activities/programmes."
      },
      {
       "id": "1.9.5",
       "text": "Expresses their responses, likes- dislikes, and asks questions."
      },
      {
       "id": "1.9.6",
       "text": "Creates rhyming words and words with similar sounds orally, in writing from familiar poems and songs."
      },
      {
       "id": "1.9.7",
       "text": "Predicts and reads textbooks and children’s literature in familiar context."
      },
      {
       "id": "1.9.8",
       "text": "Attempts to read familiar and unfamiliar text and talks about it."
      },
      {
       "id": "1.9.9",
       "text": "Understands events and characters in a picture story/storyboard (story books) and writes about them."
      },
      {
       "id": "1.9.10",
       "text": "Talks about characters, events based on the stories poems and other texts."
      },
      {
       "id": "1.9.11",
       "text": "Writes making use of appropriate words/sentences and different forms of expressions."
      },
      {
       "id": "1.9.12",
       "text": "Extends the story in writing using imagination and creativity."
      }
     ]
    },
    {
     "id": "1.10",
     "title": "Adapts to read and write Language II",
     "items": [
      {
       "id": "1.10.1",
       "text": "Expresses verbally her or his likes/dislikes about the characters, storyline, etc., in English or home language."
      },
      {
       "id": "1.10.2",
       "text": "Sings songs or rhymes with action and forms new rhyming words."
      },
      {
       "id": "1.10.3",
       "text": "Predicts the story, talks about the characters bilingually."
      },
      {
       "id": "1.10.4",
       "text": "Shares orally about events such as festival celebrated in the neighbourhood bilingually."
      },
      {
       "id": "1.10.5",
       "text": "Recognises and writes/draws frequently occurring word/picture in a story being read."
      },
      {
       "id": "1.10.6",
       "text": "Tries to decode unfamiliar words while reading."
      },
      {
       "id": "1.10.7",
       "text": "Draws a poster showing his/her feelings for the toy."
      },
      {
       "id": "1.10.8",
       "text": "Writes selective rhyming words in pair."
      },
      {
       "id": "1.10.9",
       "text": "Creates a poster on their self-created story."
      },
      {
       "id": "1.10.10",
       "text": "Responds to the questions related to stories and poems, in home language or English or sign language, orally and in writing (phrases/ short sentences)."
      },
      {
       "id": "1.10.11",
       "text": "Uses words related to size, shape, colour, weight and texture."
      },
      {
       "id": "1.10.12",
       "text": "Read texts other than the textbooks such as children’s magazine, etc."
      },
      {
       "id": "1.10.13",
       "text": "Writes small sentences about self and other things."
      },
      {
       "id": "1.10.14",
       "text": "Draws or writes a few words or short sentences in response to the environment (birds, plants, garden, etc.)poems and stories."
      },
      {
       "id": "1.10.15",
       "text": "Composes and writes simple, short sentences with space between words to express themselves."
      }
     ]
    },
    {
     "id": "1.11",
     "title": "Develops abilities and sensibilities in visual and performing arts, and expresses their emotions through art in meaningful and joyful ways",
     "items": [
      {
       "id": "1.11.1",
       "text": "Follows rules and enjoys movement and rhythm, participates in play activities."
      },
      {
       "id": "1.11.2",
       "text": "Takes initiative in creative activities, dance, music, drama, role play, mimicry, imitation, etc."
      }
     ]
    },
    {
     "id": "1.12",
     "title": "Develops habit of learning that allow him/ her to engage actively in formal learning environments like school classroom.",
     "items": [
      {
       "id": "1.12.1",
       "text": "Attention and Intentional action: Acquires skills to plan, focus attention, and direct activities to achieve specific goals."
      },
      {
       "id": "1.12.2",
       "text": "Observation, wonder, curiosity and exploration: Observes minute details of objects, wonders and explores using various senses, tinkers with objects, asks questions."
      }
     ]
    }
   ]
  },
  {
   "kind": "SMILEYS",
   "id": "2",
   "title": "Self Assessment",
   "groups": [
    {
     "id": "2.1",
     "title": "Activity that I enjoy doing with my friends",
     "items": [
      {
       "id": "2.1.1",
       "text": "Playing"
      },
      {
       "id": "2.1.2",
       "text": "Dancing"
      },
      {
       "id": "2.1.3",
       "text": "Studying"
      },
      {
       "id": "2.1.4",
       "text": "Jumping"
      },
      {
       "id": "2.1.5",
       "text": "Cleaning my classroom"
      },
      {
       "id": "2.1.6",
       "text": "Building blocks"
      }
     ]
    },
    {
     "id": "2.2",
     "title": "Activity that I find difficult",
     "items": [
      {
       "id": "2.2.1",
       "text": "Studying"
      },
      {
       "id": "2.2.2",
       "text": "Drawing"
      },
      {
       "id": "2.2.3",
       "text": "Colouring"
      },
      {
       "id": "2.2.4",
       "text": "Writing"
      },
      {
       "id": "2.2.5",
       "text": "Solving puzzles"
      },
      {
       "id": "2.2.6",
       "text": "Nothing"
      }
     ]
    },
    {
     "id": "2.3",
     "title": "Activity/ activities I enjoy the most",
     "items": [
      {
       "id": "2.3.1",
       "text": "Playing"
      },
      {
       "id": "2.3.2",
       "text": "Studying"
      },
      {
       "id": "2.3.3",
       "text": "Drawing"
      },
      {
       "id": "2.3.4",
       "text": "Colouring"
      },
      {
       "id": "2.3.5",
       "text": "Dancing"
      },
      {
       "id": "2.3.6",
       "text": "Swimming"
      },
      {
       "id": "2.3.7",
       "text": "Clay Modeling"
      },
      {
       "id": "2.3.8",
       "text": "Singing"
      },
      {
       "id": "2.3.9",
       "text": "Origami work"
      },
      {
       "id": "2.3.10",
       "text": "Quiz"
      },
      {
       "id": "2.3.11",
       "text": "Taking care of plants"
      }
     ]
    }
   ]
  },
  {
   "kind": "SMILEYS",
   "id": "3",
   "title": "Peer Assessment",
   "groups": [
    {
     "id": "3.1",
     "title": "Peer Assessment",
     "items": [
      {
       "id": "3.1.1",
       "text": "He/ She helps in completing tasks/activity."
      },
      {
       "id": "3.1.2",
       "text": "He/ She likes to play with others."
      },
      {
       "id": "3.1.3",
       "text": "He/ She shares stationery with classmates."
      }
     ]
    }
   ]
  }
 ]
},
  III: PREPARATORY,
  IV: PREPARATORY,
  V: PREPARATORY,
};

const admin = require('firebase-admin');

// Task definitions
const TASK_DEFINITIONS = {
  // Type 1 tasks - with standard variant properties
  'matrix-reasoning': {
    description: 'Matrix reasoning assessment task',
    name: 'Matrix Reasoning',
    variants: {
      corpus: 'matrix-reasoning-item-bank',
      maxIncorrect: 3,
      maxTime: 10,
      numberOfTrials: 20,
      sequentialStimulus: true
    }
  },
  'mental-rotation': {
    description: 'Mental rotation assessment task',
    name: 'Mental Rotation',
    variants: {
      corpus: 'mental-rotation-item-bank',
      maxIncorrect: 6,
      maxTime: 8,
      numberOfTrials: 300,
      sequentialStimulus: false
    }
  },
  'intro': {
    description: 'Introduction and practice task',
    name: 'Introduction',
    variants: {
      corpus: null,
      maxIncorrect: 100,
      maxTime: 100,
      numberOfTrials: 20,
      sequentialStimulus: true,
      storeItemId: true
    }
  },
  'memory-game': {
    description: 'Memory game assessment task',
    name: 'Memory Game',
    variants: {
      corpus: null,
      maxIncorrect: 3,
      maxTime: 15,
      numberOfTrials: 200,
      sequentialStimulus: true
    }
  },
  'hearts-and-flowers': {
    description: 'Hearts and flowers executive function task',
    name: 'Hearts and Flowers',
    variants: {
      corpus: null,
      maxIncorrect: 3,
      maxTime: 10,
      numberOfTrials: 20,
      sequentialStimulus: true,
      storeItemId: true
    }
  },
  'egma-math': {
    description: 'EGMA mathematics assessment',
    name: 'EGMA Math',
    variants: {
      corpus: null,
      maxIncorrect: 6,
      maxTime: 15,
      numberOfTrials: 200,
      sequentialStimulus: false
    }
  },
  'trog': {
    description: 'Test for Reception of Grammar',
    name: 'TROG',
    variants: {
      corpus: null,
      maxIncorrect: 3,
      maxTime: 8,
      numberOfTrials: 20,
      sequentialStimulus: true
    }
  },
  'theory-of-mind': {
    description: 'Theory of mind assessment task',
    name: 'Theory of Mind',
    variants: {
      corpus: null,
      maxIncorrect: 3,
      maxTime: 10,
      numberOfTrials: 20,
      sequentialStimulus: true,
      storeItemId: true
    }
  },
  'vocab': {
    description: 'Vocabulary assessment task',
    name: 'Vocabulary',
    variants: {
      corpus: null,
      maxIncorrect: 6,
      maxTime: 15,
      numberOfTrials: 300,
      sequentialStimulus: false,
      storeItemId: true
    }
  },
  'same-different-selection': {
    description: 'Same different selection task',
    name: 'Same Different Selection',
    variants: {
      corpus: null,
      maxIncorrect: 3,
      maxTime: 10,
      numberOfTrials: 20,
      sequentialStimulus: true
    }
  }
};

// Type 2 tasks - with different variant properties
const READING_TASK_DEFINITIONS = {
  'pa': {
    description: 'Phonological awareness assessment',
    name: 'Phonological Awareness',
    variants: {
      consent: true,
      recruitment: 'pilot',
      storyOption: false,
      userMode: '3min1Block',
      timerLength: 180000
    }
  },
  'sre': {
    description: 'Sentence reading efficiency assessment',
    name: 'Sentence Reading Efficiency',
    variants: {
      consent: false,
      recruitment: 'co-pilot',
      storyOption: true,
      userMode: 'shortRandom',
      addNoResponse: false,
      audioFeedbackOption: 'binary',
      numAdaptive: 150,
      numNew: 25,
      numValidated: 100
    }
  },
  'swr': {
    description: 'Sight word reading assessment',
    name: 'Sight Word Reading',
    variants: {
      consent: true,
      recruitment: 'pilot',
      storyOption: 'false',
      userMode: 'fixed',
      numTestItems: 19,
      story: null
    }
  }
};

// Special tasks with unique structures
const SPECIAL_TASK_DEFINITIONS = {
  'MEFS': {
    description: 'MEFS assessment task',
    name: 'MEFS',
    variants: {
      taskURL: 'https://apps.reflectionsciences.com/launch/d38cfed9-f303-4c02-80e5-a10528968033?',
      variantURL: 'https://apps.reflectionsciences.com/launch/d38cfed9-f303-4c02-80e5-a10528968033?'
    }
  },
  'survey': {
    description: 'Survey task',
    name: 'Survey',
    variants: {}
  }
};

// Common variant properties for Type 1 tasks
const COMMON_TYPE1_VARIANT_PROPS = {
  age: null,
  corpus: 'default',
  keyHelpers: true,
  language: 'en',
  numOfPracticeTrials: 2,
  sequentialPractice: true,
  skipInstructions: true,
  stimulusBlocks: 3
};

// Common variant properties for Type 2 tasks
const COMMON_TYPE2_VARIANT_PROPS = {
  language: 'en',
  skipInstructions: true
};

async function createTasks(adminApp) {
  const db = adminApp.firestore();
  const createdTasks = [];
  
  console.log("  Creating tasks and variants...");
  
  // Create Type 1 tasks (standard assessment tasks)
  for (const [taskId, taskDef] of Object.entries(TASK_DEFINITIONS)) {
    try {
      console.log(`    Creating task: ${taskId}...`);
      
      // Create task document
      const taskData = {
        description: taskDef.description,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        name: taskDef.name,
        registered: true,
        image: ''
      };
      
      const taskRef = db.collection('tasks').doc(taskId);
      await taskRef.set(taskData);
      console.log(`      ✅ Created task document: ${taskId}`);
      
      // Create variant document in subcollection
      const variantRef = taskRef.collection('variants').doc();
      const variantData = {
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        name: 'en',
        registered: true,
        params: {
          ...COMMON_TYPE1_VARIANT_PROPS,
          ...taskDef.variants,
          taskName: taskId
        }
      };
      
      await variantRef.set(variantData);
      const variantId = variantRef.id;
      console.log(`      ✅ Created variant: ${variantId}`);
      
      createdTasks.push({
        id: taskId,
        name: taskDef.name,
        type: 'standard',
        variantId
      });
      
    } catch (error) {
      console.error(`      ❌ Failed to create task ${taskId}:`, error.message);
      throw error;
    }
  }
  
  // Create Type 2 tasks (reading assessment tasks)
  for (const [taskId, taskDef] of Object.entries(READING_TASK_DEFINITIONS)) {
    try {
      console.log(`    Creating reading task: ${taskId}...`);
      
      // Create task document
      const taskData = {
        description: taskDef.description,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        name: taskDef.name,
        registered: true,
        image: ''
      };
      
      const taskRef = db.collection('tasks').doc(taskId);
      await taskRef.set(taskData);
      console.log(`      ✅ Created task document: ${taskId}`);
      
      // Create variant document in subcollection
      const variantRef = taskRef.collection('variants').doc();
      const variantData = {
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        name: 'en',
        registered: true,
        params: {
          ...COMMON_TYPE2_VARIANT_PROPS,
          ...taskDef.variants
        }
      };
      
      await variantRef.set(variantData);
      const variantId = variantRef.id;
      console.log(`      ✅ Created variant: ${variantId}`);
      
      createdTasks.push({
        id: taskId,
        name: taskDef.name,
        type: 'reading',
        variantId
      });
      
    } catch (error) {
      console.error(`      ❌ Failed to create reading task ${taskId}:`, error.message);
      throw error;
    }
  }
  
  // Create Special tasks (MEFS and survey)
  for (const [taskId, taskDef] of Object.entries(SPECIAL_TASK_DEFINITIONS)) {
    try {
      console.log(`    Creating special task: ${taskId}...`);
      
      // Create task document
      const taskData = {
        description: taskDef.description,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        name: taskDef.name,
        registered: true,
        image: ''
      };

      if (taskId === 'MEFS') {
        taskData.taskURL = 'https://apps.reflectionsciences.com/launch/d38cfed9-f303-4c02-80e5-a10528968033?';
      }
      
      const taskRef = db.collection('tasks').doc(taskId);
      await taskRef.set(taskData);
      console.log(`      ✅ Created task document: ${taskId}`);
      
      // Create variant document in subcollection
      const variantRef = taskRef.collection('variants').doc();
      const variantData = {
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        name: 'All Languages',
        registered: true,
        params: {},
        ...taskDef.variants
      };
      
      await variantRef.set(variantData);
      const variantId = variantRef.id;
      console.log(`      ✅ Created variant: ${variantId}`);
      
      createdTasks.push({
        id: taskId,
        name: taskDef.name,
        type: 'special',
        variantId
      });
      
    } catch (error) {
      console.error(`      ❌ Failed to create special task ${taskId}:`, error.message);
      throw error;
    }
  }
  
  console.log(`  ✅ Created ${createdTasks.length} tasks with variants`);
  
  return createdTasks;
}

module.exports = { createTasks }; 
